import { chromium } from 'playwright';
import fs from 'node:fs';
import path from 'node:path';
import { canonicalMarketKey, canonicalSelection } from '../normalize/markets.js';

// The real boabet sportsbook lives at play.boabet-39-eu.com (boabet.com 307s
// through 3 casino-affiliate redirects). Tech stack: Digitain (per the
// `digitain-widgets.*.js` bundle observed in the diagnostic). Mirror list
// in case the -39- counter rotates.
// Route discovered from the landing-page nav (2026-06-11): the sportsbook
// lives under /en/sports/sportsbook — the old /en/sport path 404s in-app.
// The -NN- mirror counter rotates but old counters 307 to the current one.
const MIRRORS = [
  'https://play.boabet-39-eu.com/en/sports/sportsbook/overview',
  'https://play.boabet-39-eu.com/en/sports/sportsbook',
  'https://www.boabet.com/en/sports/sportsbook/overview'
];
const SAMPLE_DIR = 'data/samples';
const SAVE_SAMPLES = process.env.SAVE_SAMPLES === '1';

export async function scrapeBoabet() {
  for (const url of MIRRORS) {
    try {
      const events = await scrapeOne(url);
      if (events.length) {
        console.log(`  boabet mirror used: ${url}`);
        return events;
      }
    } catch (err) {
      console.warn(`  boabet mirror failed (${url}): ${err.message}`);
    }
  }
  return [];
}

async function scrapeOne(entryUrl) {
  const browser = await chromium.launch({
    headless: true,
    args: ['--disable-blink-features=AutomationControlled']
  });
  const ctx = await browser.newContext({
    userAgent:
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
      '(KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36',
    locale: 'hu-HU',
    viewport: { width: 1366, height: 900 }
  });
  // light stealth: hide webdriver flag
  await ctx.addInitScript(() => {
    Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
  });
  const page = await ctx.newPage();

  const payloads = [];
  page.on('response', async res => {
    const ct = res.headers()['content-type'] || '';
    if (!ct.includes('json')) return;
    const url = res.url();
    if (!/sport|event|odd|prematch|upcoming|market|fixture|digitain|widget|champ|competition/i.test(url)) return;
    try {
      const json = await res.json();
      payloads.push({ url, json });
    } catch {}
  });

  // Digitain sportsbooks push odds over SignalR WebSockets, invisible to
  // page.on('response') — capture frames too.
  const wsFrames = [];
  page.on('websocket', ws => {
    const grab = ev => ev.payload && wsFrames.push({ url: ws.url(), payload: String(ev.payload).slice(0, 500_000) });
    ws.on('framereceived', grab);
  });

  let finalUrl = '', title = '', html = '';
  try {
    await page.goto(entryUrl, { waitUntil: 'domcontentloaded', timeout: 60000 });
    await page.waitForLoadState('networkidle', { timeout: 30000 }).catch(() => {});

    // A OneTrust consent banner blocks the page until accepted — the
    // sportsbook fragment never initializes behind it (verified via HTML
    // snapshot: #onetrust-banner-sdk present, no sportsbook iframe).
    const consent = page.locator('#onetrust-accept-btn-handler');
    if (await consent.count().catch(() => 0)) {
      await consent.first().click({ timeout: 5000 }).catch(() => {});
      console.log('  boabet: accepted OneTrust consent banner');
      await page.waitForLoadState('networkidle', { timeout: 20000 }).catch(() => {});
    }

    // Boabet's sportsbook fragment takes a moment to negotiate auth + fetch odds
    await page.waitForTimeout(25000);
    finalUrl = page.url();
    title = await page.title().catch(() => '');
    if (SAVE_SAMPLES) html = await page.content().catch(() => '');
  } finally {
    await browser.close();
  }

  console.log(`  boabet ${entryUrl}: ${payloads.length} json payloads, ${wsFrames.length} ws frames; landed on "${finalUrl}" (title: ${JSON.stringify(title)})`);
  if (SAVE_SAMPLES) {
    writeSamples('boabet', payloads);
    writeWsFrames('boabet', wsFrames);
    if (html) {
      fs.mkdirSync(SAMPLE_DIR, { recursive: true });
      const slug = entryUrl.replace(/[^a-z0-9]+/gi, '_').slice(-50);
      fs.writeFileSync(path.join(SAMPLE_DIR, `boabet-html-${slug}.html`), html);
    }
  }
  return parseBoabetPayloads([...payloads, ...wsFramesAsPayloads(wsFrames)]);
}

// SignalR frames are JSON messages separated by \x1e; try to parse each part
// so the generic payload parser gets a shot at them too.
function wsFramesAsPayloads(wsFrames) {
  const out = [];
  for (const f of wsFrames) {
    for (const part of f.payload.split('')) {
      if (!part.trim().startsWith('{') && !part.trim().startsWith('[')) continue;
      try { out.push({ url: f.url, json: JSON.parse(part) }); } catch {}
    }
  }
  return out;
}

function writeWsFrames(prefix, wsFrames) {
  if (!wsFrames.length) return;
  fs.mkdirSync(SAMPLE_DIR, { recursive: true });
  fs.writeFileSync(
    path.join(SAMPLE_DIR, `${prefix}-ws-frames.jsonl`),
    wsFrames.map(f => JSON.stringify(f)).join('\n')
  );
}

function writeSamples(prefix, payloads) {
  fs.mkdirSync(SAMPLE_DIR, { recursive: true });
  for (let i = 0; i < payloads.length; i++) {
    const safe = payloads[i].url.replace(/[^a-z0-9]+/gi, '_').slice(-80);
    fs.writeFileSync(
      path.join(SAMPLE_DIR, `${prefix}-${i}-${safe}.json`),
      JSON.stringify(payloads[i].json, null, 2)
    );
  }
}

// Boabet's backend shape is unknown until the first capture. This parser tries
// several common shapes (Altenar, Kambi, Betradar, generic). After the first
// run with SAVE_SAMPLES=1, refine the heuristics here based on the captured JSON.
function parseBoabetPayloads(payloads) {
  const events = [];
  for (const { json } of payloads) {
    for (const raw of guessEventList(json)) {
      const parsed = parseGenericEvent(raw);
      if (parsed) events.push(parsed);
    }
  }
  return dedupeById(events);
}

function guessEventList(json) {
  if (!json || typeof json !== 'object') return [];
  const candidates = [
    json.Events, json.events,
    json.Result?.Events, json.result?.events,
    json.Items, json.items,
    json.fixtures, json.matches, json.data
  ];
  for (const c of candidates) if (Array.isArray(c) && c.length) return c;
  // walk one level deep
  for (const v of Object.values(json)) {
    if (Array.isArray(v) && v.length && typeof v[0] === 'object') return v;
  }
  return [];
}

function parseGenericEvent(e) {
  if (!e || typeof e !== 'object') return null;
  const id = e.Id ?? e.id ?? e.eventId ?? e.EventId ?? e.fixtureId;
  if (!id) return null;

  const startUtc =
    e.EventDate || e.StartDate || e.startDate || e.startTime || e.kickoff || e.date;
  if (!startUtc) return null;

  let home, away;
  const parts = e.Participants || e.participants || e.competitors;
  if (Array.isArray(parts) && parts.length >= 2) {
    home = parts[0].Name ?? parts[0].name;
    away = parts[1].Name ?? parts[1].name;
  } else {
    home = e.home ?? e.HomeTeam ?? e.homeTeam;
    away = e.away ?? e.AwayTeam ?? e.awayTeam;
  }
  if (!home || !away) return null;

  const sport = e.SportName || e.sportName || e.sport || 'unknown';
  const league =
    e.ChampionshipName || e.championshipName || e.LeagueName ||
    e.leagueName || e.league || '';

  const markets = [];
  const betsRaw =
    e.Bets || e.bets || e.markets || e.Markets || e.odds || [];
  for (const bet of betsRaw) {
    const key = canonicalMarketKey(bet.Name || bet.name || bet.marketName);
    if (!key) continue;
    const odds = {};
    const sels = bet.Selections || bet.Outcomes || bet.outcomes || bet.selections || [];
    for (const sel of sels) {
      const selKey = canonicalSelection(key, sel.Name || sel.name || sel.outcomeName);
      const price = sel.Price ?? sel.price ?? sel.odds ?? sel.decimalOdds;
      if (selKey && Number.isFinite(price) && price > 1) odds[selKey] = price;
    }
    if (Object.keys(odds).length) markets.push({ key, odds });
  }
  if (!markets.length) return null;

  return {
    bookId: `boabet-${id}`,
    source: 'boabet',
    sport,
    league,
    home,
    away,
    startUtc: new Date(startUtc).toISOString(),
    markets
  };
}

function dedupeById(events) {
  const seen = new Map();
  for (const e of events) seen.set(e.bookId, e);
  return [...seen.values()];
}
