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
  // Digitain's dgiframe host runs a bot validation that rejects headless
  // Chromium. BOABET_HEADED=1 launches a real (headed) browser — in CI,
  // wrap the run in xvfb-run to provide a display.
  const browser = await chromium.launch({
    headless: process.env.BOABET_HEADED !== '1',
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
    const url = res.url();
    // Digitain (sport.dgiframe.com) serves its odds JSON with
    // content-type: text/html and a light XOR obfuscation — a content-type
    // filter silently drops every odds payload (root cause of 0 records
    // through 2026-06-11). Capture everything from the sportsbook backends
    // and let decodeDigitain() sort it out.
    if (/dgiframe|sportdigi/i.test(url)) {
      if (/\.(png|jpg|jpeg|gif|svg|webp|woff2?|css|ttf|ico|mp4|webm|js)(\?|$)/i.test(url)) return;
      try {
        const json = decodeDigitain(await res.body());
        if (json) payloads.push({ url, json });
      } catch {}
      return;
    }
    const ct = res.headers()['content-type'] || '';
    if (!ct.includes('json')) return;
    if (!/sport|event|odd|prematch|upcoming|market|fixture|digitain|widget|champ|competition/i.test(url)) return;
    try {
      const json = await res.json();
      payloads.push({ url, json });
    } catch {}
  });

  // Remember a real gettopeventslist request so per-sport refetches reuse the
  // exact same query params (langId/partnerId/countryCode/stakeTypes).
  let topEventsTpl = null;
  page.on('request', req => {
    if (!topEventsTpl && /gettopeventslist/i.test(req.url())) topEventsTpl = req.url();
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

    // Digitain's validation page ("Egy pillanat…") redirects back to the
    // sportsbook once its checks pass — give it time before sampling.
    if (page.url().includes('/Error/Validate')) {
      console.log('  boabet: waiting out dgiframe bot validation …');
      await page.waitForURL(u => !String(u).includes('/Error/Validate'), { timeout: 30000 }).catch(() => {});
    }

    // Boabet's sportsbook fragment takes a moment to negotiate auth + fetch odds
    await page.waitForTimeout(15000);

    // The overview page only loads promo banners — the actual odds lists are
    // fetched when the pre-match section opens.
    if (/\/sports\/sportsbook/.test(page.url()) && !page.url().includes('pre-match')) {
      const preMatch = new URL('/en/sports/sportsbook/pre-match', page.url()).href;
      console.log(`  boabet: opening pre-match section …`);
      await page.goto(preMatch, { waitUntil: 'domcontentloaded', timeout: 45000 }).catch(e => console.warn(`  boabet pre-match nav: ${e.message}`));
      await page.waitForLoadState('networkidle', { timeout: 20000 }).catch(() => {});
      await page.waitForTimeout(15000);
    }

    // The pre-match page only auto-loads Football's top events. Pull the
    // other sports' lists directly from inside the Digitain iframe (same
    // origin/cookies, so the Cloudflare + bot checks already passed).
    await fetchTopEventsPerSport(page, topEventsTpl, payloads);

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
  // Sample filenames truncate URLs — keep a full-URL index for parser work.
  fs.appendFileSync(
    path.join(SAMPLE_DIR, `${prefix}-url-index.txt`),
    payloads.map((p, i) => `${i}\t${JSON.stringify(p.json).length}B\t${p.url}`).join('\n') + '\n'
  );
}

// Digitain sport ids confirmed via prematch/getsportswithcount (2026-06-11).
// Only sports the other sources also carry are worth fetching.
const DIGITAIN_SPORTS = {
  1: 'Football',
  3: 'Tennis',
  4: 'Basketball',
  5: 'Baseball',
  10: 'Ice Hockey',
  12: 'Volleyball',
  13: 'Handball'
};

async function fetchTopEventsPerSport(page, tplUrl, payloads) {
  const frame = page.frames().find(f => /dgiframe\.com\/.+\/SportsBook/i.test(f.url()));
  if (!frame) {
    console.warn('  boabet: Digitain iframe not found — skipping per-sport fetch');
    return;
  }
  if (!tplUrl) {
    // No organic request observed — build one from the iframe URL (the GUID
    // path segment is the partner system id) with the params seen in capture.
    const u = new URL(frame.url());
    const guid = u.pathname.split('/')[1];
    tplUrl = `${u.origin}/${guid}/prematch/gettopeventslist?sportId=1&stakeTypes=1&stakeTypes=702&stakeTypes=2&stakeTypes=3&stakeTypes=992&stakeTypes=46&langId=2&partnerId=749&countryCode=HU`;
  }
  for (const [sportId, name] of Object.entries(DIGITAIN_SPORTS)) {
    const url = tplUrl.replace(/sportId=\d+/, `sportId=${sportId}`);
    // fetch() inside the frame → response also lands in page.on('response'),
    // but grab it directly so a slow listener can't race browser.close().
    const b64 = await frame.evaluate(async u => {
      try {
        const r = await fetch(u, { credentials: 'include' });
        const bytes = new Uint8Array(await r.arrayBuffer());
        let s = '';
        for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
        return btoa(s);
      } catch { return null; }
    }, url).catch(() => null);
    if (!b64) continue;
    const json = decodeDigitain(Buffer.from(b64, 'base64'));
    if (json) {
      console.log(`  boabet ${name}: ${Array.isArray(json) ? json.length : '?'} top events`);
      payloads.push({ url, json });
    }
  }
}

// Digitain obfuscates JSON bodies: the stream is split into 8192-byte chunks,
// each prefixed with one marker byte, and the rest is XORed with a single-byte
// key. Derive the key from the first data byte (JSON starts with '[' or '{').
function decodeDigitain(buf) {
  if (!buf || !buf.length) return null;
  try { return JSON.parse(buf.toString('utf8')); } catch {}
  const marker = buf[0];
  const data = [];
  for (let i = 0; i < buf.length; i++) {
    if (i % 8192 === 0) {
      if (buf[i] !== marker) return null;
      continue;
    }
    data.push(buf[i]);
  }
  if (!data.length) return null;
  for (const open of [0x5b, 0x7b]) { // '[' / '{'
    const key = data[0] ^ open;
    try { return JSON.parse(Buffer.from(data.map(c => c ^ key)).toString('utf8')); } catch {}
  }
  return null;
}

// Payloads are either Digitain event lists (gettopeventslist & friends) or
// the odd generic JSON; try the Digitain shape first, generic second.
function parseBoabetPayloads(payloads) {
  const events = [];
  for (const { json } of payloads) {
    for (const raw of guessEventList(json)) {
      const parsed = parseDigitainEvent(raw) ?? parseGenericEvent(raw);
      if (parsed) events.push(parsed);
    }
  }
  return dedupeById(events);
}

// Digitain pre-match event: { Id, HT, AT, SN, CN, D, StakeTypes: [{ N,
// Stakes: [{ N, SC, A, F }] }] }. SC: 1=home, 2=draw, 3=away. A = line
// argument (totals/handicaps). F = decimal price.
function parseDigitainEvent(e) {
  if (!e || typeof e !== 'object') return null;
  if (!e.Id || !e.HT || !e.AT || !e.D || !Array.isArray(e.StakeTypes)) return null;

  const markets = [];
  const seen = new Set();
  for (const st of e.StakeTypes) {
    const stakes = Array.isArray(st.Stakes) ? st.Stakes : [];
    if (!stakes.length) continue;

    if (/^(result|winner|match winner)$/i.test(st.N || '')) {
      // Selections are named after the teams; 'X' marks the draw. SC codes
      // are positional fallbacks: 1/2/3 = home/draw/away in 3-way markets
      // but 1/2 = home/away in 2-way ones (tennis, baseball, …).
      const threeWay = stakes.length === 3;
      const odds = {};
      for (const s of stakes) {
        const sel =
          s.N === e.HT ? '1'
          : s.N === e.AT ? '2'
          : s.N === 'X' || /^draw$/i.test(s.N || '') ? 'X'
          : s.SC === 1 ? '1'
          : s.SC === 2 ? (threeWay ? 'X' : '2')
          : s.SC === 3 ? '2'
          : null;
        if (sel && Number.isFinite(s.F) && s.F > 1) odds[sel] = s.F;
      }
      // 3 selections → 1x2; 2 (no draw posted) → winner
      const key = 'X' in odds ? '1x2' : 'winner';
      const complete = key === '1x2' ? odds['1'] && odds['2'] && odds['X'] : odds['1'] && odds['2'];
      if (complete && !seen.has(key)) {
        seen.add(key);
        markets.push({ key, odds });
      }
    }

    // Exactly 'Total' = match goals. 'Total Games'/'Total Points'/… are
    // different units and must not feed the goals-based ou_2.5 market.
    if (/^total$/i.test(st.N || '')) {
      const over = stakes.find(s => /^over$/i.test(s.N || '') && Math.abs(Number(s.A) - 2.5) < 0.01);
      const under = stakes.find(s => /^under$/i.test(s.N || '') && Math.abs(Number(s.A) - 2.5) < 0.01);
      if (over?.F > 1 && under?.F > 1 && !seen.has('ou_2.5')) {
        seen.add('ou_2.5');
        markets.push({ key: 'ou_2.5', odds: { over: over.F, under: under.F } });
      }
    }
  }
  if (!markets.length) return null;

  return {
    bookId: `boabet-${e.Id}`,
    source: 'boabet',
    sport: e.SN || 'unknown',
    league: e.CN || '',
    home: e.HT,
    away: e.AT,
    startUtc: new Date(e.D).toISOString(),
    markets
  };
}

function guessEventList(json) {
  if (!json || typeof json !== 'object') return [];
  if (Array.isArray(json)) return json;
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
