import 'dotenv/config';
import { scrapeVegas } from './scrapers/vegas.js';
import { scrapeTippmixpro } from './scrapers/tippmixpro.js';
import { scrapeBoabet } from './scrapers/boabet.js';
import { scrapeTwentyTwoBet } from './scrapers/twentytwobet.js';
import { clusterEvents } from './normalize/events.js';
import { sendDiscord } from './alert/discord.js';
import { loadSeen, saveSeen, filterNew, markSeen, pruneSeen } from './alert/dedup.js';

const DRY = process.argv.includes('--dry-run');
// Minimum guaranteed profit (% of total stake) required to alert. Typical
// arbs run 0.5-3%; default 0.5 catches them all and we sort by best-first.
const MIN_PROFIT_PCT = Number(process.env.ALERT_THRESHOLD_PCT ?? 0.5);
const TOP_N = Number(process.env.ALERT_TOP_N ?? 10);
const STAKE_BASE = Number(process.env.STAKE_BASE ?? 100);
// Re-alert a previously posted arb only when its profit improved by more
// than this many percentage points.
const DEDUP_IMPROVE_PCT = Number(process.env.DEDUP_IMPROVE_PCT ?? 0.3);
const SEEN_PATH = process.env.SEEN_ARBS_PATH ?? 'data/seen-arbs.json';

// Arb-eligible markets and their full selection sets. 1x2 is a genuine
// 3-leg arb (one leg per outcome, legs spread across ≥2 books); the rest are
// classic 2-leg two-way markets. An arb needs EVERY selection covered, so a
// market only qualifies when the best-of-cluster prices span all of them.
const ARB_MARKETS = {
  winner: ['1', '2'],
  btts: ['yes', 'no'],
  'ou_2.5': ['over', 'under'],
  '1x2': ['1', 'X', '2'],
};

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

// Per cluster + market: pick the best price for every selection across all
// member books. Returns null when the market isn't comparable (fewer than 2
// books carry it, or a selection is missing entirely).
//
// A 3-way 1x2 from one book is never mixed with a 2-way winner from another:
// normalizedMarketKey keeps the two as distinct keys, so a draw can never be
// left unhedged by accident.
function bestOfCluster(cluster, marketKey, selections) {
  const best = {};
  let booksWithMarket = 0;
  for (const [source, ev] of Object.entries(cluster.members)) {
    const m = ev.markets.find(x => normalizedMarketKey(x) === marketKey);
    if (!m) continue;
    booksWithMarket++;
    for (const sel of selections) {
      const price = m.odds[sel];
      if (!Number.isFinite(price)) continue;
      if (!best[sel] || price > best[sel].odds) best[sel] = { odds: price, book: source };
    }
  }
  if (booksWithMarket < 2) return null;
  if (!selections.every(s => best[s])) return null;
  return best;
}

export function arbsInCluster(cluster) {
  const out = [];
  for (const [marketKey, selections] of Object.entries(ARB_MARKETS)) {
    const best = bestOfCluster(cluster, marketKey, selections);
    if (!best) continue;

    // All legs at one book is just that book's (negative-margin?) market —
    // not a cross-book arb we can lock in.
    if (new Set(selections.map(s => best[s].book)).size < 2) continue;

    const totalImplied = selections.reduce((t, s) => t + 1 / best[s].odds, 0);
    if (totalImplied >= 1) continue;

    out.push({
      sport: cluster.sport,
      home: cluster.home,
      away: cluster.away,
      league: cluster.league,
      startUtc: cluster.startUtc,
      market: marketKey,
      legs: selections.map(s => ({
        selection: s,
        odds: best[s].odds,
        book: best[s].book,
        stake: (STAKE_BASE * (1 / best[s].odds)) / totalImplied,
      })),
      totalStake: STAKE_BASE,
      guaranteedReturn: STAKE_BASE / totalImplied,
      profitPct: (1 - totalImplied) / totalImplied * 100
    });
  }
  return out;
}

// Per cluster + arb-eligible market, the best-of-cluster implied total.
// Sorted ascending so the lowest (= closest to arb) is first. Returns
// structured rows so discord.js can format them however it wants.
function nearArbOverview(clusters) {
  const rows = [];
  for (const cluster of clusters) {
    for (const [marketKey, selections] of Object.entries(ARB_MARKETS)) {
      const best = bestOfCluster(cluster, marketKey, selections);
      if (!best) continue;
      const total = selections.reduce((t, s) => t + 1 / best[s].odds, 0);
      rows.push({
        total,
        overroundPct: (total - 1) * 100,
        market: marketKey,
        home: cluster.home,
        away: cluster.away,
        sport: cluster.sport,
        startUtc: cluster.startUtc
      });
    }
  }
  rows.sort((x, y) => x.total - y.total);
  return rows;
}

// One failing scraper (transient DNS, dead mirror, rotated MGO IDs…) must
// not abort the whole scan — the remaining sources can still find arbs.
async function scrapeSafe(label, fn) {
  console.log(`Scraping ${label} …`);
  let all = [];
  try {
    all = await fn();
  } catch (err) {
    console.warn(`  [${label}] scrape FAILED, continuing without it: ${err.message}`);
  }
  const windowed = all.filter(inWindow);
  console.log(`  → ${all.length} total, ${windowed.length} in window`);
  return windowed;
}

async function main() {
  console.log(`Window: ${new Date(WINDOW_MIN_MS).toISOString()} → ${new Date(WINDOW_MAX_MS).toISOString()}`);

  const vegas = await scrapeSafe('vegas.hu', scrapeVegas);
  const tipp  = await scrapeSafe('tippmixpro.hu', scrapeTippmixpro);
  const bet22 = await scrapeSafe('22bet (LineFeed)', scrapeTwentyTwoBet);
  // boabet costs a headed Chromium launch (~1 min) and flaps when Digitain's
  // bot wall rotates — ENABLE_BOABET=0 turns it off without a code change.
  const boa = process.env.ENABLE_BOABET === '0'
    ? []
    : await scrapeSafe('boabet (Playwright)', scrapeBoabet);

  // Cluster the same real-world match across all sources, then arb each
  // cluster on best-of-cluster prices.
  console.log('Clustering events across sources …');
  const clusters = clusterEvents([
    ['vegas', vegas], ['tippmixpro', tipp], ['bet22', bet22], ['boabet', boa],
  ]);
  const sizeCounts = {};
  for (const c of clusters) {
    const n = Object.keys(c.members).length;
    sizeCounts[n] = (sizeCounts[n] || 0) + 1;
  }
  const sizeSummary = Object.entries(sizeCounts).map(([n, c]) => `${c}×${n}-book`).join('  ');
  console.log(`  → ${clusters.length} clusters (${sizeSummary || 'none'})`);

  const allArbs = clusters.flatMap(arbsInCluster);
  allArbs.sort((a, b) => b.profitPct - a.profitPct);
  const profitable = allArbs.filter(a => a.profitPct >= MIN_PROFIT_PCT);
  console.log(`  → ${profitable.length} arbs ≥ ${MIN_PROFIT_PCT}% profit; sending top ${Math.min(profitable.length, TOP_N)}`);

  const nearMisses = nearArbOverview(clusters);

  if (DRY || profitable.length === 0) {
    console.log(`\n=== Closest near-arbs (lowest overround = closest to profit) ===`);
    for (const m of nearMisses.slice(0, 10)) {
      const start = new Date(m.startUtc).toISOString().slice(0, 16).replace('T', ' ');
      console.log(`  overround=${m.overroundPct.toFixed(2)}%  ${m.market.padEnd(7)}  ${m.home} vs ${m.away}  [${start}]`);
    }
    if (!nearMisses.length) console.log('  (no arb-eligible cluster markets found)');
  }

  // De-dup against previous runs: the cron rediscovers the same arb every
  // 20 minutes; only newly seen (or meaningfully improved) ones get posted.
  const top = profitable.slice(0, TOP_N);
  const seen = loadSeen(SEEN_PATH);
  pruneSeen(seen);
  const fresh = DRY ? top : filterNew(top, seen, DEDUP_IMPROVE_PCT);
  if (top.length && !fresh.length) {
    console.log(`  → all ${top.length} arbs already alerted in a previous run (dedup)`);
  }
  markSeen(top, seen);
  if (!DRY) saveSeen(SEEN_PATH, seen);

  const summary = {
    sources: { vegas: vegas.length, tippmixpro: tipp.length, bet22: bet22.length, boabet: boa.length },
    clusterCount: clusters.length,
    eligibleMarketCount: nearMisses.length,
    threshold: MIN_PROFIT_PCT,
    closest: nearMisses[0] || null,
  };

  // Silent unless there's something to act on: post only for fresh arbs, or
  // when HEARTBEAT=1 forces a "scan healthy" status (one scheduled run a day
  // sets it so a silent week is distinguishable from a broken pipeline).
  if (DRY) {
    await sendDiscord(null, { arbs: fresh, summary });
  } else if (fresh.length || process.env.HEARTBEAT === '1') {
    await sendDiscord(process.env.DISCORD_WEBHOOK_URL, { arbs: fresh, summary });
  } else {
    console.log('No new arbs — staying silent (no Discord post).');
  }
}

// Only run when executed directly (node src/compare.js) — lets tests import
// arbsInCluster without kicking off a full scrape.
import { pathToFileURL } from 'node:url';
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(err => {
    console.error(err);
    process.exit(1);
  });
}
