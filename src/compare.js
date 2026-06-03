import 'dotenv/config';
import { scrapeVegas } from './scrapers/vegas.js';
import { scrapeTippmixpro } from './scrapers/tippmixpro.js';
import { matchEvents } from './normalize/events.js';
import { sendDiscord } from './alert/discord.js';

const DRY = process.argv.includes('--dry-run');
// Minimum guaranteed profit (% of total stake) required to alert. Typical
// arbs run 0.5-3%; default 0.5 catches them all and we sort by best-first.
const MIN_PROFIT_PCT = Number(process.env.ALERT_THRESHOLD_PCT ?? 0.5);
const TOP_N = Number(process.env.ALERT_TOP_N ?? 10);
const STAKE_BASE = Number(process.env.STAKE_BASE ?? 100);

// Only 2-outcome markets are eligible for 2-leg arbitrage. 1X2 (3 outcomes)
// is excluded by design - user wants "both sides of a single bet on different
// platforms", which means one leg per book.
const TWO_LEG_MARKETS = new Set(['winner', 'btts', 'ou_2.5']);

const now = Date.now();
const WINDOW_MIN_MS = now + 2 * 3600 * 1000;
const WINDOW_MAX_MS = now + 7 * 24 * 3600 * 1000;

function inWindow(e) {
  const t = new Date(e.startUtc).getTime();
  return Number.isFinite(t) && t >= WINDOW_MIN_MS && t <= WINDOW_MAX_MS;
}

// A "1x2" market with only {1, 2} selections (no Draw) is functionally a
// 2-way winner market - this happens for basketball/baseball where one book
// (tippmixpro) labels every match-outcome market 1X2 even when there's no draw.
function normalizedMarketKey(market) {
  if (market.key === '1x2' && !('X' in market.odds)) return 'winner';
  return market.key;
}

function arbsBetween(vEvent, tEvent) {
  const out = [];
  for (const vmRaw of vEvent.markets) {
    const vmKey = normalizedMarketKey(vmRaw);
    if (!TWO_LEG_MARKETS.has(vmKey)) continue;
    const tmRaw = tEvent.markets.find(m => normalizedMarketKey(m) === vmKey);
    if (!tmRaw) continue;
    const vm = { key: vmKey, odds: vmRaw.odds };
    const tm = { key: vmKey, odds: tmRaw.odds };

    const selections = [...new Set([...Object.keys(vm.odds), ...Object.keys(tm.odds)])];
    if (selections.length !== 2) continue;
    if (!selections.every(s => Number.isFinite(vm.odds[s]) && Number.isFinite(tm.odds[s]))) continue;

    const [selA, selB] = selections;
    const bestA = vm.odds[selA] >= tm.odds[selA]
      ? { odds: vm.odds[selA], book: 'vegas' }
      : { odds: tm.odds[selA], book: 'tippmixpro' };
    const bestB = vm.odds[selB] >= tm.odds[selB]
      ? { odds: vm.odds[selB], book: 'vegas' }
      : { odds: tm.odds[selB], book: 'tippmixpro' };

    if (bestA.book === bestB.book) continue;

    const totalImplied = 1 / bestA.odds + 1 / bestB.odds;
    if (totalImplied >= 1) continue;

    const stakeA = (STAKE_BASE * (1 / bestA.odds)) / totalImplied;
    const stakeB = (STAKE_BASE * (1 / bestB.odds)) / totalImplied;
    const guaranteedReturn = STAKE_BASE / totalImplied;
    const profitPct = (1 - totalImplied) / totalImplied * 100;

    out.push({
      sport: vEvent.sport,
      home: vEvent.home,
      away: vEvent.away,
      league: vEvent.league,
      startUtc: vEvent.startUtc,
      market: vm.key,
      legA: { selection: selA, odds: bestA.odds, book: bestA.book, stake: stakeA },
      legB: { selection: selB, odds: bestB.odds, book: bestB.book, stake: stakeB },
      totalStake: STAKE_BASE,
      guaranteedReturn,
      profitPct
    });
  }
  return out;
}

// Per matched pair + arb-eligible market, compute the best-of-both implied
// total. Sorted ascending so the lowest (= closest to arb) is first. Returns
// structured rows so discord.js can format them however it wants.
function nearArbOverview(pairs) {
  const rows = [];
  for (const { vegas: v, tipp: t } of pairs) {
    for (const vmRaw of v.markets) {
      const key = normalizedMarketKey(vmRaw);
      if (!TWO_LEG_MARKETS.has(key)) continue;
      const tmRaw = t.markets.find(m => normalizedMarketKey(m) === key);
      if (!tmRaw) continue;
      const vm = { key, odds: vmRaw.odds };
      const tm = { key, odds: tmRaw.odds };
      const sels = [...new Set([...Object.keys(vm.odds), ...Object.keys(tm.odds)])];
      if (sels.length !== 2 || !sels.every(s => Number.isFinite(vm.odds[s]) && Number.isFinite(tm.odds[s]))) continue;
      const [a, b] = sels;
      const bestA = Math.max(vm.odds[a], tm.odds[a]);
      const bestB = Math.max(vm.odds[b], tm.odds[b]);
      const total = 1 / bestA + 1 / bestB;
      rows.push({
        total,
        overroundPct: (total - 1) * 100,
        market: key,
        home: v.home,
        away: v.away,
        sport: v.sport,
        startUtc: v.startUtc
      });
    }
  }
  rows.sort((x, y) => x.total - y.total);
  return rows;
}

async function main() {
  console.log(`Window: ${new Date(WINDOW_MIN_MS).toISOString()} → ${new Date(WINDOW_MAX_MS).toISOString()}`);

  console.log('Scraping vegas.hu …');
  const vegasAll = await scrapeVegas();
  const vegas = vegasAll.filter(inWindow);
  console.log(`  → ${vegasAll.length} total events, ${vegas.length} in window`);

  console.log('Scraping tippmixpro.hu …');
  const tippAll = await scrapeTippmixpro();
  const tipp = tippAll.filter(inWindow);
  console.log(`  → ${tippAll.length} total events, ${tipp.length} in window`);

  console.log('Matching events …');
  const pairs = matchEvents(vegas, tipp);
  console.log(`  → ${pairs.length} matched event pairs`);

  const allArbs = pairs.flatMap(p => arbsBetween(p.vegas, p.tipp));
  allArbs.sort((a, b) => b.profitPct - a.profitPct);
  const profitable = allArbs.filter(a => a.profitPct >= MIN_PROFIT_PCT);
  console.log(`  → ${profitable.length} arbs ≥ ${MIN_PROFIT_PCT}% profit; sending top ${Math.min(profitable.length, TOP_N)}`);

  const nearMisses = nearArbOverview(pairs);

  if (DRY || profitable.length === 0) {
    console.log(`\n=== Closest book differences on eligible markets (lowest = best near-arb) ===`);
    for (const m of nearMisses.slice(0, 10)) {
      const start = new Date(m.startUtc).toISOString().slice(0, 16).replace('T', ' ');
      console.log(`  overround=${m.overroundPct.toFixed(2)}%  ${m.market.padEnd(7)}  ${m.home} vs ${m.away}  [${start}]`);
    }
    if (!nearMisses.length) {
      console.log('  (no arb-eligible market pairs)');
    }
  }

  await sendDiscord(DRY ? null : process.env.DISCORD_WEBHOOK_URL, {
    arbs: profitable.slice(0, TOP_N),
    summary: {
      vegasInWindow: vegas.length,
      tippInWindow: tipp.length,
      pairCount: pairs.length,
      eligibleMarketCount: nearMisses.length,
      threshold: MIN_PROFIT_PCT,
      closest: nearMisses[0] || null
    }
  });
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
