import { WebSocket } from 'ws';
import fs from 'node:fs';
import path from 'node:path';
import { canonicalMarketKey, canonicalSelection } from '../normalize/markets.js';

// tippmixpro uses EveryMatrix's WAMP v2 protocol over WebSocket. Discovered via
// src/ws-capture.js. No REST endpoint exists; the SPA fetches everything via
// CALL /sports#initialDump on Wampy.js topics.
//
// Behind NordVPN HU (api hosts geo-blocked outside Hungary). For local debug
// connect VPN first; in GH Actions the workflow connects NordVPN HU before run.
const WS_URL = 'wss://sportsapi.tippmixpro.hu/v2';
const REALM = 'www.tippmixpro.hu';
const PARTNER = '2901';
const LANG = 'hu';

const SAMPLE_DIR = 'data/samples';
const SAVE_SAMPLES = process.env.SAVE_SAMPLES === '1';

// HU betting-type names from inspect-ws.js. Mapped to canonical keys here so
// we don't need to load the alias table; bettingTypeId is more reliable.
// 7 = "Ki nyeri?" (Who wins) - 2-way and tennis/basketball/baseball default
// 69 = "1X2" - football 3-way
// 76 = "Mindkét csapat szerez gólt" - both teams to score
// 47 = "Gólszám" - goal count (over/under, multi-line)
const MARKET_KEY_BY_BETTING_TYPE = {
  7: 'winner',
  69: '1x2',
  76: 'btts',
  47: 'ou_2.5' // only kept when MARKET line is 2.5 - see parser
};

// Per-sport Market Group Overview (MGO) IDs, discovered via src/probe-mgo-fine.js
// and src/probe-mgo-wide.js. The aggregator-groups-overview topic returns
// matches+markets when called with valid MGO IDs for that sport. Including
// more MGOs gives more market coverage; we list the ones that produce the
// canonical markets compare.js cares about (1X2, winner/Ki nyeri?, O/U, BTTS).
const SPORT_MGOS = {
  1:  { name: 'Labdarúgás (Football)',    mgos: [1380, 1381, 1382, 1383] }, // 1X2, O/U, BTTS, double-chance
  3:  { name: 'Tenisz (Tennis)',          mgos: [2369, 2370] },             // winner, game totals
  6:  { name: 'Jégkorong (Hockey)',       mgos: [559, 560, 561] },          // 1X2, O/U, winner
  7:  { name: 'Kézilabda (Handball)',     mgos: [565, 566] },               // 1X2, O/U
  8:  { name: 'Kosárlabda (Basketball)',  mgos: [570, 571, 573] },          // winner, points-total, 1X2
  9:  { name: 'Baseball',                 mgos: [574, 575, 577] },          // winner, points-total, 1X2
  20: { name: 'Röplabda (Volleyball)',    mgos: [579, 580] },               // winner, points-total
  22: { name: 'Vízilabda (Waterpolo)',    mgos: [582, 583, 586] },          // 1X2, O/U, winner
  28: { name: 'Rögbi (Rugby)',            mgos: [707, 708, 710] },          // 1X2, points, winner
  49: { name: 'Futsal',                   mgos: [697, 698] }                // 1X2, O/U
};

// How many matches to request per sport. NOTE: the aggregator hard-caps at
// 200 server-side — run 27337961405 requested 300 and still got exactly 200
// for football/tennis. Requesting more is harmless but does nothing; getting
// past 200 would need a different topic (e.g. per-league queries).
const MATCHES_PER_SPORT = Number(process.env.TIPPMIX_MATCHES_PER_SPORT ?? 300);

const WAMP_SESSION_TIMEOUT_MS = 120000;

export async function scrapeTippmixpro() {
  const records = await withWampSession(async ({ call }) => {
    const collected = [];
    const entries = Object.entries(SPORT_MGOS);

    console.log(`  tippmixpro: fetching ${entries.length} sports in parallel …`);
    const results = await Promise.all(
      entries.map(async ([sportId, { name, mgos }]) => {
        const topic = `/sports/${PARTNER}/${LANG}/highlighted-popular-matches-aggregator-groups-overview/${sportId}/${MATCHES_PER_SPORT}/${mgos.join(',')}/default-event-info/or1.0-100.0`;
        try {
          const r = await call(topic);
          const matches = r.filter(x => x._type === 'MATCH').length;
          const markets = r.filter(x => x._type === 'MARKET').length;
          console.log(`    sport ${sportId.padStart(2)} ${name.padEnd(28)} ${matches.toString().padStart(4)} matches, ${markets.toString().padStart(4)} markets`);
          return r;
        } catch (err) {
          console.warn(`    sport ${sportId} (${name}) failed: ${err.message}`);
          return [];
        }
      })
    );
    for (const r of results) collected.push(...r);
    console.log(`  tippmixpro: ${collected.length} records collected`);
    return collected;
  });

  if (SAVE_SAMPLES) {
    fs.mkdirSync(SAMPLE_DIR, { recursive: true });
    fs.writeFileSync(
      path.join(SAMPLE_DIR, 'tippmixpro-records.json'),
      JSON.stringify(records, null, 2)
    );
  }
  return joinRecordsToEvents(records);
}

// --- WAMP v2 minimal client (subset: HELLO, CALL, RESULT, ERROR) ---
//
// Opens one session, awaits WELCOME, then invokes fn({ call }) where call(topic)
// returns the records[] from CALL /sports#initialDump with that topic. Resolves
// with whatever fn returns; closes the WS on success or error.

function withWampSession(fn) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(WS_URL, ['wamp.2.json'], {
      headers: {
        'User-Agent':
          'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
          '(KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36',
        'Origin': 'https://www.tippmixpro.hu'
      }
    });
    let nextReqId = 1;
    const pending = new Map(); // requestId -> { resolve, reject }
    let helloAcked = false;
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      ws.terminate();
      reject(new Error(`tippmixpro WAMP timeout (${WAMP_SESSION_TIMEOUT_MS}ms)`));
    }, WAMP_SESSION_TIMEOUT_MS);

    const finish = (err, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (err) {
        try { ws.terminate(); } catch {}
        reject(err);
      } else {
        try { ws.close(); } catch {}
        resolve(value);
      }
    };

    const send = msg => ws.send(JSON.stringify(msg));

    const call = topic => new Promise((res, rej) => {
      if (settled) return rej(new Error('WAMP session closed'));
      const reqId = nextReqId++;
      pending.set(reqId, { resolve: res, reject: rej });
      send([48, reqId, {}, '/sports#initialDump', [], { topic }]);
    });

    ws.on('open', () => {
      send([1, REALM, {
        agent: 'Wampy.js v6.2.2',
        roles: {
          publisher: { features: {} },
          subscriber: { features: {} },
          caller: { features: {} },
          callee: { features: {} }
        },
        authmethods: ['wampcra'],
        authid: 'webapi-wampy'
      }]);
    });

    ws.on('message', async raw => {
      let msg;
      try { msg = JSON.parse(raw.toString('utf8')); } catch { return; }
      const op = msg[0];

      if (op === 2 && !helloAcked) { // WELCOME
        helloAcked = true;
        try {
          const value = await fn({ call });
          finish(null, value);
        } catch (err) {
          finish(err);
        }
        return;
      }

      if (op === 50) { // RESULT [50, reqId, details, args, kwargs]
        const reqId = msg[1];
        const kwargs = msg[4] || {};
        const records = Array.isArray(kwargs.records) ? kwargs.records : [];
        const p = pending.get(reqId);
        if (p) {
          pending.delete(reqId);
          p.resolve(records);
        }
        return;
      }

      if (op === 8) { // ERROR [8, requestType, requestId, details, error, args?, kwargs?]
        const reqId = msg[2];
        const p = pending.get(reqId);
        if (p) {
          pending.delete(reqId);
          // resolve empty so callers can decide to tolerate; their try/catch
          // around individual call() invocations can re-classify if needed.
          p.resolve([]);
        }
      }
    });

    ws.on('error', err => finish(err));
    ws.on('close', () => {
      if (!settled && pending.size > 0) {
        finish(new Error('WAMP socket closed with pending CALLs'));
      }
    });
  });
}

// --- record join: MATCH ← MARKET ← MARKET_OUTCOME_RELATION ← OUTCOME ← BETTING_OFFER ---

export const _joinRecordsToEventsForTest = (records) => joinRecordsToEvents(records);

function joinRecordsToEvents(records) {
  const matches = new Map();         // id → MATCH
  const markets = new Map();         // id → MARKET
  const outcomes = new Map();        // id → OUTCOME
  const offersByOutcome = new Map(); // outcomeId → BETTING_OFFER (best/latest)
  const outcomesByMarket = new Map(); // marketId → [outcomeId,...]

  for (const r of records) {
    switch (r._type) {
      case 'MATCH':
        if (r.id) matches.set(String(r.id), r);
        break;
      case 'MARKET':
        if (r.id) markets.set(String(r.id), r);
        break;
      case 'OUTCOME':
        if (r.id) outcomes.set(String(r.id), r);
        break;
      case 'MARKET_OUTCOME_RELATION': {
        const mid = String(r.marketId);
        const list = outcomesByMarket.get(mid) || [];
        list.push(String(r.outcomeId));
        outcomesByMarket.set(mid, list);
        break;
      }
      case 'BETTING_OFFER':
        if (r.outcomeId && Number.isFinite(r.odds) && r.isAvailable !== false) {
          offersByOutcome.set(String(r.outcomeId), r);
        }
        break;
    }
  }

  // Group markets by event so we can build markets[] per event
  const marketsByEvent = new Map();
  for (const market of markets.values()) {
    const eventId = String(market.eventId);
    if (!matches.has(eventId)) continue;
    const list = marketsByEvent.get(eventId) || [];
    list.push(market);
    marketsByEvent.set(eventId, list);
  }

  const events = [];
  for (const match of matches.values()) {
    const evMarkets = marketsByEvent.get(String(match.id)) || [];
    const canonicalMarkets = [];

    for (const market of evMarkets) {
      const key = mapMarketKey(market);
      if (!key) continue;
      const outcomeIds = outcomesByMarket.get(String(market.id)) || [];
      const odds = {};
      for (const oid of outcomeIds) {
        const outcome = outcomes.get(oid);
        const offer = offersByOutcome.get(oid);
        if (!outcome || !offer) continue;
        const selKey = mapTippmixproSelection(key, outcome, match);
        if (!selKey) continue;
        // If duplicates, keep the higher (most recently offered) odd
        if (!(selKey in odds) || offer.odds > odds[selKey]) {
          odds[selKey] = offer.odds;
        }
      }
      if (Object.keys(odds).length >= 2) {
        canonicalMarkets.push({ key, odds });
      }
    }

    if (!canonicalMarkets.length) continue;
    if (!match.startTime) continue;
    if (!match.homeParticipantName || !match.awayParticipantName) continue;

    events.push({
      bookId: `tippmixpro-${match.id}`,
      source: 'tippmixpro',
      sport: match.sportName || `sport_${match.sportId}`,
      league: match.parentName || '',
      home: match.homeParticipantName,
      away: match.awayParticipantName,
      startUtc: new Date(match.startTime).toISOString(),
      markets: canonicalMarkets
    });
  }

  return events;
}

function mapMarketKey(market) {
  // Prefer bettingTypeId (numeric, stable). Fall back to HU name alias lookup.
  const byId = MARKET_KEY_BY_BETTING_TYPE[market.bettingTypeId];
  if (byId === 'ou_2.5') {
    // Only ou_2.5 specifically; "Gólszám" covers many lines (1.5, 2.5, 3.5...).
    const line = extractMarketLine(market);
    if (line !== 2.5) return null;
    return 'ou_2.5';
  }
  if (byId) return byId;
  return canonicalMarketKey(market.displayName || market.name);
}

function extractMarketLine(market) {
  // Lines are usually in displayName / name like "Gólszám 2.5" or in
  // outcome params. The market record sometimes carries a numeric param.
  const candidates = [market.line, market.totalLine, market.param];
  for (const c of candidates) {
    const n = Number(c);
    if (Number.isFinite(n) && n > 0) return n;
  }
  const text = `${market.displayName || ''} ${market.name || ''} ${market.shortName || ''}`;
  const m = text.match(/(\d+(?:[.,]\d)?)/);
  if (m) {
    const n = Number(m[1].replace(',', '.'));
    if (Number.isFinite(n)) return n;
  }
  return null;
}

function mapTippmixproSelection(marketKey, outcome, match) {
  // OUTCOME.paramParticipantId1 is the team this outcome relates to for
  // home/away markets. For draw, paramParticipantId1 is absent and typeName
  // is "Draw" / translatedName is "Döntetlen".
  const part = outcome.paramParticipantId1
    ? String(outcome.paramParticipantId1)
    : null;
  const homeId = match.homeParticipantId ? String(match.homeParticipantId) : null;
  const awayId = match.awayParticipantId ? String(match.awayParticipantId) : null;
  const name = (outcome.translatedName || outcome.typeName || '').toLowerCase();

  if (marketKey === '1x2') {
    if (part && part === homeId) return '1';
    if (part && part === awayId) return '2';
    if (name.includes('döntetlen') || name === 'draw' || name === 'x') return 'X';
    return null;
  }
  if (marketKey === 'winner') {
    if (part && part === homeId) return '1';
    if (part && part === awayId) return '2';
    return null;
  }
  if (marketKey === 'ou_2.5') {
    if (name.includes('felett') || name.startsWith('over') || name.startsWith('o ')) return 'over';
    if (name.includes('alatt') || name.startsWith('under') || name.startsWith('u ')) return 'under';
    return null;
  }
  if (marketKey === 'btts') {
    if (name.startsWith('igen') || name.startsWith('yes')) return 'yes';
    if (name.startsWith('nem') || name.startsWith('no')) return 'no';
    return null;
  }
  return canonicalSelection(marketKey, outcome.translatedName || outcome.typeName);
}
