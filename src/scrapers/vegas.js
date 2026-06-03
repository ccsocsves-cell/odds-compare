import axios from 'axios';
import fs from 'node:fs';
import path from 'node:path';
import { canonicalMarketKey, canonicalSelection } from '../normalize/markets.js';

// Altenar API endpoint that vegas.hu calls under the hood (discovered via the
// diagnostic spike in src/diag.js). No Playwright needed.
const BASE = 'https://hu-sb2frontend-altenar2.biahosted.com/api/widget';
const COMMON = {
  culture: 'en-GB',
  timezoneOffset: '-120',
  integration: 'vegas.hu',
  deviceType: '1',
  numFormat: 'hu-HU',
  countryCode: 'HU'
};
// Major sport IDs (from data/samples/ topSports payloads):
// 66=Football, 67=Basketball, 68=Tennis, 70=Ice Hockey, 69=Volleyball, 71=Boxing, 146=E-Football
const SPORT_IDS = [66, 67, 68, 70, 69, 71, 146];
const SAMPLE_DIR = 'data/samples';
const SAVE_SAMPLES = process.env.SAVE_SAMPLES === '1';

export async function scrapeVegas() {
  const all = [];
  for (const sportId of SPORT_IDS) {
    const events = await fetchSport(sportId);
    console.log(`  vegas sport ${sportId}: ${events.length} events`);
    all.push(...events);
  }
  return dedupeById(all);
}

async function fetchSport(sportId) {
  // GetTopEvents with eventCount=0 returns the full list, not the top N.
  const params = { ...COMMON, eventCount: '0', sportId: String(sportId), timePeriod: '0' };
  const url = `${BASE}/GetTopEvents`;
  const res = await axios.get(url, {
    params,
    timeout: 30000,
    headers: {
      'accept': 'application/json',
      'origin': 'https://vegas.hu',
      'referer': 'https://vegas.hu/',
      'user-agent':
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
        '(KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36'
    },
    validateStatus: () => true
  });

  if (SAVE_SAMPLES) {
    fs.mkdirSync(SAMPLE_DIR, { recursive: true });
    fs.writeFileSync(
      path.join(SAMPLE_DIR, `vegas-direct-sport${sportId}.json`),
      JSON.stringify(res.data, null, 2)
    );
  }

  if (res.status !== 200 || !res.data) {
    console.warn(`  vegas sport ${sportId} returned status ${res.status}`);
    return [];
  }
  return parseAltenarPayload(res.data);
}

function parseAltenarPayload(json) {
  if (!json || !Array.isArray(json.events) || !Array.isArray(json.competitors)) return [];

  const competitorById = new Map(json.competitors.map(c => [c.id, c]));
  const marketById = new Map((json.markets || []).map(m => [m.id, m]));
  const oddById = new Map((json.odds || []).map(o => [o.id, o]));
  const sportById = new Map((json.sports || []).map(s => [s.id, s]));
  const champById = new Map((json.champs || []).map(c => [c.id, c]));

  const out = [];
  for (const e of json.events) {
    const parsed = parseAltenarEvent(e, {
      competitorById, marketById, oddById, sportById, champById
    });
    if (parsed) out.push(parsed);
  }
  return out;
}

function parseAltenarEvent(e, lookups) {
  const { competitorById, marketById, oddById, sportById, champById } = lookups;

  const compIds = e.competitorIds || [];
  if (compIds.length < 2) return null;
  const home = competitorById.get(compIds[0])?.name;
  const away = competitorById.get(compIds[1])?.name;
  if (!home || !away) return null;

  const startUtc = e.startDate || e.StartDate;
  if (!startUtc) return null;

  const sport = sportById.get(e.sportId)?.name || `sport_${e.sportId}`;
  const league = champById.get(e.champId)?.name || '';
  const homeCompId = compIds[0];
  const awayCompId = compIds[1];

  const markets = [];
  for (const marketId of e.marketIds || []) {
    const market = marketById.get(marketId);
    if (!market) continue;
    const key = canonicalMarketKey(market.name || market.headerName);
    if (!key) continue;
    const odds = {};
    for (const oddId of market.oddIds || []) {
      const odd = oddById.get(oddId);
      if (!odd) continue;
      const price = odd.price;
      if (!Number.isFinite(price) || price <= 1) continue;
      const selKey = mapAltenarSelection(key, odd, homeCompId, awayCompId);
      if (selKey) odds[selKey] = price;
    }
    if (Object.keys(odds).length) markets.push({ key, odds });
  }
  if (!markets.length) return null;

  return {
    bookId: `vegas-${e.id}`,
    source: 'vegas',
    sport,
    league,
    home,
    away,
    startUtc: new Date(startUtc).toISOString(),
    markets
  };
}

function mapAltenarSelection(marketKey, odd, homeCompId, awayCompId) {
  const compId = odd.competitorId;
  if (marketKey === '1x2') {
    if (compId === homeCompId) return '1';
    if (compId === awayCompId) return '2';
    const n = (odd.name || '').toLowerCase().trim();
    if (n === 'x' || n === 'draw' || n === 'döntetlen') return 'X';
    return null;
  }
  if (marketKey === 'winner') {
    if (compId === homeCompId) return '1';
    if (compId === awayCompId) return '2';
    return null;
  }
  return canonicalSelection(marketKey, odd.name);
}

function dedupeById(events) {
  const seen = new Map();
  for (const e of events) seen.set(e.bookId, e);
  return [...seen.values()];
}
