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
    // Use the normalized key so downstream output / near-arb diag also reads cleanly
    const vm = { key: vmKey, odds: vmRaw.odds };
    const tm = { key: vmKey, odds: tmRaw.odds };

    // Must have exactly the same 2 selections quoted on both books
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

    // Cross-platform requirement: each leg must be on a different book
    if (bestA.book === bestB.book) continue;

    const totalImplied = 1 / bestA.odds + 1 / bestB.odds;
    if (totalImplied >= 1) continue; // no arb - bookies overround

    // Stake split that equalizes payout across both legs:
    //   payout = STAKE_BASE / totalImplied (same regardless of outcome)
    //   stake_A = STAKE_BASE * (1/oA) / totalImplied
    //   stake_B = STAKE_BASE * (1/oB) / totalImplied
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

  // Diagnostic: show what each matched pair looks like + closest arb misses.
  if (DRY || profitable.length === 0) {
    console.log(`\n=== Matched pair market coverage ===`);
    for (const { vegas: v, tipp: t } of pairs) {
      const vKeys = v.markets.map(m => m.key);
      const tKeys = t.markets.map(m => m.key);
      const common = vKeys.filter(k => tKeys.includes(k));
      const eligible = common.filter(k => TWO_LEG_MARKETS.has(k));
      console.log(`  ${v.sport.padEnd(12)} ${v.home} vs ${v.away}`);
      console.log(`    vegas: [${vKeys.join(', ')}]  tipp: [${tKeys.join(', ')}]  arb-eligible: [${eligible.join(', ') || '—'}]`);
    }
    const nearMisses = nearArbOverview(pairs);
    if (nearMisses.length) {
      console.log(`\n=== Closest book differences on eligible markets (overround = how far from arb) ===`);
      for (const m of nearMisses.slice(0, 10)) console.log(`  ${m}`);
    } else {
      console.log(`\nNo arb-eligible market pairs in this scrape (need winner / btts / ou_2.5 on both books for the same match).`);
    }
  }

  await sendDiscord(DRY ? null : process.env.DISCORD_WEBHOOK_URL, profitable.slice(0, TOP_N));
}

// Diagnostic: per matched pair + market, compute the best-of-both implied
// total. Show the lowest (closest to 1.00 = arb threshold). Output is a list
// of one-line summaries sorted by closeness.
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
      const startShort = new Date(v.startUtc).toISOString().slice(0, 16).replace('T', ' ');
      rows.push({
        total,
        line: `total=${total.toFixed(4)} (overround ${((total - 1) * 100).toFixed(2)}%)  ${vm.key.padEnd(7)}  ${v.home} vs ${v.away}  [${startShort}]`
      });
    }
  }
  rows.sort((x, y) => x.total - y.total);
  return rows.map(r => r.line);
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
