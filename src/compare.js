import 'dotenv/config';
import { scrapeVegas } from './scrapers/vegas.js';
import { scrapeTippmixpro } from './scrapers/tippmixpro.js';
import { scrapeOddsApi } from './scrapers/oddsapi.js';
import { scrapeBoabet } from './scrapers/boabet.js';
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
    const vm = { key: vmKey, odds: vmRaw.odds, books: vmRaw.books };
    const tm = { key: vmKey, odds: tmRaw.odds, books: tmRaw.books };

    const selections = [...new Set([...Object.keys(vm.odds), ...Object.keys(tm.odds)])];
    if (selections.length !== 2) continue;
    if (!selections.every(s => Number.isFinite(vm.odds[s]) && Number.isFinite(tm.odds[s]))) continue;

    // Aggregated sources (oddsapi) carry per-selection book attribution in
    // market.books — prefer that over the generic event source name.
    const bookOf = (mkt, ev, sel) => mkt.books?.[sel] ?? ev.source;
    const [selA, selB] = selections;
    const bestA = vm.odds[selA] >= tm.odds[selA]
      ? { odds: vm.odds[selA], book: bookOf(vm, vEvent, selA) }
      : { odds: tm.odds[selA], book: bookOf(tm, tEvent, selA) };
    const bestB = vm.odds[selB] >= tm.odds[selB]
      ? { odds: vm.odds[selB], book: bookOf(vm, vEvent, selB) }
      : { odds: tm.odds[selB], book: bookOf(tm, tEvent, selB) };

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

// The oddsapi source aggregates 10 bookmakers, so a single event can carry
// an internal arb (e.g. Over best at pinnacle, Under best at williamhill).
// These don't need a cross-source match at all.
function arbsWithinEvent(e) {
  const out = [];
  for (const mRaw of e.markets) {
    const key = normalizedMarketKey(mRaw);
    if (!TWO_LEG_MARKETS.has(key) || !mRaw.books) continue;
    const sels = Object.keys(mRaw.odds);
    if (sels.length !== 2) continue;
    const [selA, selB] = sels;
    if (!Number.isFinite(mRaw.odds[selA]) || !Number.isFinite(mRaw.odds[selB])) continue;
    if (mRaw.books[selA] === mRaw.books[selB]) continue;

    const totalImplied = 1 / mRaw.odds[selA] + 1 / mRaw.odds[selB];
    if (totalImplied >= 1) continue;

    out.push({
      sport: e.sport,
      home: e.home,
      away: e.away,
      league: e.league,
      startUtc: e.startUtc,
      market: key,
      legA: { selection: selA, odds: mRaw.odds[selA], book: mRaw.books[selA], stake: (STAKE_BASE * (1 / mRaw.odds[selA])) / totalImplied },
      legB: { selection: selB, odds: mRaw.odds[selB], book: mRaw.books[selB], stake: (STAKE_BASE * (1 / mRaw.odds[selB])) / totalImplied },
      totalStake: STAKE_BASE,
      guaranteedReturn: STAKE_BASE / totalImplied,
      profitPct: (1 - totalImplied) / totalImplied * 100
    });
  }
  return out;
}

// Per matched pair + arb-eligible market, compute the best-of-both implied
// total. Sorted ascending so the lowest (= closest to arb) is first. Returns
// structured rows so discord.js can format them however it wants.
function nearArbOverview(pairs) {
  const rows = [];
  for (const { a: v, b: t } of pairs) {
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
  console.log(`  → ${vegasAll.length} total, ${vegas.length} in window`);

  console.log('Scraping tippmixpro.hu …');
  const tippAll = await scrapeTippmixpro();
  const tipp = tippAll.filter(inWindow);
  console.log(`  → ${tippAll.length} total, ${tipp.length} in window`);

  console.log('Scraping The Odds API (best of 10 books) …');
  const oddsAll = await scrapeOddsApi();
  const odds = oddsAll.filter(inWindow);
  console.log(`  → ${oddsAll.length} total, ${odds.length} in window`);

  console.log('Scraping boabet (Playwright) …');
  let boaAll = [];
  try {
    boaAll = await scrapeBoabet();
  } catch (err) {
    console.warn(`  [boabet] scrape failed: ${err.message}`);
  }
  const boa = boaAll.filter(inWindow);
  console.log(`  → ${boaAll.length} total, ${boa.length} in window`);

  // Match events across every source pair and collect arbs.
  console.log('Matching events across all pairs …');
  const sources = [
    ['vegas', vegas], ['tipp', tipp], ['oddsapi', odds], ['boabet', boa],
  ];
  const allPairs = [];
  const pairCounts = [];
  for (let i = 0; i < sources.length; i++) {
    for (let j = i + 1; j < sources.length; j++) {
      const [nameA, evsA] = sources[i];
      const [nameB, evsB] = sources[j];
      if (!evsA.length || !evsB.length) continue;
      const pairs = matchEvents(evsA, evsB).map(p => ({ a: p.vegas, b: p.tipp }));
      allPairs.push(...pairs);
      pairCounts.push(`${pairs.length} ${nameA}/${nameB}`);
    }
  }
  console.log(`  → ${pairCounts.join('  ') || 'no source pair had events on both sides'}`);

  // Cross-source arbs from matched pairs + intra-oddsapi arbs (best Over at
  // one book, best Under at another — no cross-source match needed).
  const internalArbs = odds.flatMap(arbsWithinEvent);
  if (internalArbs.length) console.log(`  → ${internalArbs.length} intra-oddsapi arbs`);
  const allArbs = [...allPairs.flatMap(p => arbsBetween(p.a, p.b)), ...internalArbs];
  allArbs.sort((a, b) => b.profitPct - a.profitPct);
  const profitable = allArbs.filter(a => a.profitPct >= MIN_PROFIT_PCT);
  console.log(`  → ${profitable.length} arbs ≥ ${MIN_PROFIT_PCT}% profit; sending top ${Math.min(profitable.length, TOP_N)}`);

  const nearMisses = nearArbOverview(allPairs);

  if (DRY || profitable.length === 0) {
    console.log(`\n=== Closest near-arbs (lowest overround = closest to profit) ===`);
    for (const m of nearMisses.slice(0, 10)) {
      const start = new Date(m.startUtc).toISOString().slice(0, 16).replace('T', ' ');
      console.log(`  overround=${m.overroundPct.toFixed(2)}%  ${m.market.padEnd(7)}  ${m.home} vs ${m.away}  [${start}]`);
    }
    if (!nearMisses.length) console.log('  (no arb-eligible market pairs found)');
  }

  await sendDiscord(DRY ? null : process.env.DISCORD_WEBHOOK_URL, {
    arbs: profitable.slice(0, TOP_N),
    summary: {
      sources: { vegas: vegas.length, tippmixpro: tipp.length, oddsapi: odds.length, boabet: boa.length },
      pairCount: allPairs.length,
      eligibleMarketCount: nearMisses.length,
      threshold: MIN_PROFIT_PCT,
      closest: nearMisses[0] || null,
    }
  });
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
