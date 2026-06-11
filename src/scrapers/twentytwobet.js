import axios from 'axios';
import fs from 'node:fs';
import path from 'node:path';

// 22bet runs the 1xCorp platform; the odds JSON lives under
// /service-api/LineFeed/ on the mirror host of the day. 22bet.com
// 308-redirects to the current mirror but lowercases the path (which 404s),
// so we follow the redirect only to DISCOVER the host, then call the API
// with the proper CamelCase path ourselves. BET22_BASE overrides everything
// when both the entry domain and the fallback mirror are dead.
const ENTRY_URL = 'https://22bet.com/';
const FALLBACK_BASE = 'https://22bt104.info/service-api/LineFeed';

// 1xCorp sport ids → English sport names (must stay inside SPORT_ALIASES in
// normalize/events.js so canonicalSport() can match them against vegas/tipp).
const SPORTS = {
  1: 'Football',
  2: 'Ice Hockey',
  3: 'Basketball',
  4: 'Tennis',
  5: 'Baseball',
  6: 'Volleyball',
  7: 'Rugby',
  8: 'Handball',
  14: 'Futsal',
  17: 'Water Polo',
};

// GetGameZip market groups → canonical markets. Verified against live
// captures (SAVE_SAMPLES=1): G=1 carries T1=home/T2=draw/T3=away, G=17 is
// totals with a P line per variant, G=19 is BTTS T180=yes/T181=no. If 22bet
// ever rotates these ids, fix them here and nowhere else.
const MARKET_MAP = {
  1:  { kind: '1x2',    selByT: { 1: '1', 2: 'X', 3: '2' } },
  17: { kind: 'ou_2.5', selByT: { 9: 'over', 10: 'under' }, line: 2.5 },
  19: { kind: 'btts',   selByT: { 180: 'yes', 181: 'no' } },
};

// GetChampZip returns games WITHOUT inline odds on this deployment, so every
// windowed game costs one GetGameZip call. Cap the walk so a 20-min cron run
// stays polite: top champs by game count, then nearest kickoffs first.
const MAX_CHAMPS_PER_SPORT = Number(process.env.BET22_MAX_CHAMPS ?? 40);
const MAX_GAMES_PER_SPORT = Number(process.env.BET22_MAX_GAMES ?? 120);
const CONCURRENCY = 4; // in-flight overlap; actual request rate is gated by REQUEST_GAP_MS

// Outright/special pseudo-championships ("World Cup 2026. Team vs Player",
// player statistics, …) pollute the champ list; their "games" aren't
// team-vs-team events.
const SKIP_CHAMP_RE = /team vs player|special bets|statistics|player|outright|short[- ]term/i;

// Same alert window as compare.js: pre-match only, 2h..7d out. Filtering here
// (and not just in compare.js) is what keeps the GetGameZip call count down.
const WINDOW_MIN_MS = Date.now() + 2 * 3600 * 1000;
const WINDOW_MAX_MS = Date.now() + 7 * 24 * 3600 * 1000;

const SAMPLE_DIR = 'data/samples';
const SAVE_SAMPLES = process.env.SAVE_SAMPLES === '1';

const HEADERS = {
  accept: 'application/json',
  'user-agent':
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
    '(KHTML, like Gecko) Chrome/137.0.0.0 Safari/537.36',
};

// The WAF answers HTTP 529 ("overloaded") when requests come in too hot.
// Gate every request start through a global minimum gap and retry 529s with
// backoff — bisected empirically: ~8 parallel ungated requests trip it.
// Too aggressive probing earns a temporary IP-level ban (TCP timeouts), so
// stay well under the radar by default.
const REQUEST_GAP_MS = Number(process.env.BET22_GAP_MS ?? 250);
const RETRY_STATUS = new Set([429, 529]);
const RETRY_DELAYS_MS = [1000, 3000, 9000];

let baseCache = null;
let nextSlot = 0;

const sleep = ms => new Promise(r => setTimeout(r, ms));

async function throttle() {
  const now = Date.now();
  const wait = Math.max(0, nextSlot - now);
  nextSlot = Math.max(now, nextSlot) + REQUEST_GAP_MS;
  if (wait) await sleep(wait);
}

async function resolveBase() {
  if (baseCache) return baseCache;
  if (process.env.BET22_BASE) return (baseCache = process.env.BET22_BASE);
  try {
    const res = await axios.get(ENTRY_URL, {
      maxRedirects: 0,
      timeout: 15000,
      headers: HEADERS,
      validateStatus: s => s >= 200 && s < 400,
    });
    const loc = res.headers?.location;
    if (loc) {
      const origin = new URL(loc, ENTRY_URL).origin;
      baseCache = `${origin}/service-api/LineFeed`;
      console.log(`  22bet mirror resolved: ${baseCache}`);
      return baseCache;
    }
  } catch (err) {
    console.warn(`  22bet mirror discovery failed (${err.message}), using fallback`);
  }
  return (baseCache = FALLBACK_BASE);
}

async function lineFeed(endpoint, params) {
  const base = await resolveBase();
  for (let attempt = 0; ; attempt++) {
    await throttle();
    const res = await axios.get(`${base}/${endpoint}`, {
      params,
      timeout: 30000,
      headers: HEADERS,
      validateStatus: () => true,
    });
    if (res.status === 200 && res.data?.Success) return res.data.Value;
    if (RETRY_STATUS.has(res.status) && attempt < RETRY_DELAYS_MS.length) {
      await sleep(RETRY_DELAYS_MS[attempt]);
      continue;
    }
    throw new Error(`${endpoint} → HTTP ${res.status} / Success=${res.data?.Success}`);
  }
}

// Tiny promise pool — run fn over items with bounded concurrency, drop rejections.
async function pool(items, limit, fn) {
  const out = [];
  let i = 0;
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, async () => {
      while (i < items.length) {
        const item = items[i++];
        try {
          const r = await fn(item);
          if (r) out.push(r);
        } catch { /* one dead game must not kill the sport */ }
      }
    })
  );
  return out;
}

export async function scrapeTwentyTwoBet() {
  const all = [];
  for (const [sportId, sportName] of Object.entries(SPORTS)) {
    try {
      const events = await fetchSport(Number(sportId), sportName);
      console.log(`  22bet ${sportName}: ${events.length} events`);
      all.push(...events);
    } catch (err) {
      console.warn(`  22bet ${sportName} FAILED: ${err.message}`);
    }
  }
  return all;
}

async function fetchSport(sportId, sportName) {
  // WAF quirk (verified by bisection): requests 406 when `country` appears
  // before `tf` in the query string. Object property order is what axios
  // serializes, so keep `country` LAST and spread `common` after the
  // endpoint-specific params.
  const common = { lng: 'en', tf: 1000000, tz: 2, country: 80 };
  const champs = await lineFeed('GetChampsZip', { sport: sportId, ...common });

  const walkable = (champs || [])
    .filter(c => c.LI && c.GC > 0 && !SKIP_CHAMP_RE.test(c.L || ''))
    .sort((a, b) => (b.GC || 0) - (a.GC || 0))
    .slice(0, MAX_CHAMPS_PER_SPORT);

  // Champ walk: collect windowed team-vs-team games (no odds yet).
  const gameLists = await pool(walkable, CONCURRENCY, async c => {
    const v = await lineFeed('GetChampZip', { champ: c.LI, sport: sportId, ...common });
    return (v?.G || []).filter(g =>
      g.I && g.O1 && g.O2 &&
      Number.isFinite(g.S) &&
      g.S * 1000 >= WINDOW_MIN_MS && g.S * 1000 <= WINDOW_MAX_MS
    );
  });
  const games = dedupeBy(gameLists.flat(), g => g.I)
    .sort((a, b) => a.S - b.S)
    .slice(0, MAX_GAMES_PER_SPORT);

  // Per-game enrich: GetGameZip carries 1x2 + totals + BTTS in one response.
  const events = await pool(games, CONCURRENCY, async g => {
    const v = await lineFeed('GetGameZip', {
      id: g.I, isSubGames: true, GroupEvents: true, countevents: 250, ...common,
    });
    if (SAVE_SAMPLES && !fs.existsSync(path.join(SAMPLE_DIR, `bet22-game-sport${sportId}.json`))) {
      fs.mkdirSync(SAMPLE_DIR, { recursive: true });
      fs.writeFileSync(
        path.join(SAMPLE_DIR, `bet22-game-sport${sportId}.json`),
        JSON.stringify(v, null, 2)
      );
    }
    return parseGame(v, sportName);
  });
  return events;
}

function parseGame(v, sportName) {
  if (!v?.I || !v.O1 || !v.O2 || !Number.isFinite(v.S)) return null;

  const markets = [];
  for (const group of v.GE || []) {
    const spec = MARKET_MAP[group.G];
    if (!spec) continue;

    const odds = {};
    // GE[].E is an array of rows; each row is an array of line variants
    // ({T: outcome type, C: decimal price, P: line parameter}).
    for (const row of group.E || []) {
      for (const o of Array.isArray(row) ? row : [row]) {
        const sel = spec.selByT[o?.T];
        if (!sel) continue;
        if (spec.line !== undefined && Math.abs(Number(o.P) - spec.line) > 0.01) continue;
        const price = Number(o.C);
        if (!Number.isFinite(price) || price <= 1) continue;
        odds[sel] = price;
      }
    }

    if (spec.kind === '1x2') {
      // Draw-less sports come through the same group with only T1/T3.
      const key = 'X' in odds ? '1x2' : 'winner';
      const need = key === '1x2' ? ['1', 'X', '2'] : ['1', '2'];
      if (need.every(s => s in odds)) markets.push({ key, odds });
    } else if (Object.keys(odds).length === Object.keys(spec.selByT).length) {
      markets.push({ key: spec.kind, odds });
    }
  }
  if (!markets.length) return null;

  return {
    bookId: `bet22-${v.I}`,
    source: 'bet22',
    sport: sportName,
    league: v.L || '',
    home: v.O1,
    away: v.O2,
    startUtc: new Date(v.S * 1000).toISOString(),
    markets,
  };
}

function dedupeBy(items, keyFn) {
  const seen = new Map();
  for (const it of items) seen.set(keyFn(it), it);
  return [...seen.values()];
}
