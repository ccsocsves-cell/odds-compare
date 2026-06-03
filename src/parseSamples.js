// Run the vegas parser against the captured sample files in data/samples/
// (offline; no Playwright). Useful for tuning without re-running the spike.
import fs from 'node:fs';
import path from 'node:path';
import { canonicalMarketKey, canonicalSelection } from './normalize/markets.js';

const SAMPLE_DIR = 'data/samples';

const files = fs.readdirSync(SAMPLE_DIR)
  .filter(f => f.endsWith('.json'))
  .map(f => ({ path: path.join(SAMPLE_DIR, f), name: f }));

const payloads = files.map(f => {
  try {
    return { url: f.name, json: JSON.parse(fs.readFileSync(f.path, 'utf8')) };
  } catch {
    return null;
  }
}).filter(Boolean);

console.log(`Loaded ${payloads.length} payloads.`);

const eventyPayloads = payloads.filter(p =>
  p.json && Array.isArray(p.json.events) && Array.isArray(p.json.competitors)
);
console.log(`Of those, ${eventyPayloads.length} have events+competitors arrays.`);

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

const seenIds = new Set();
const allEvents = [];

for (const { json } of eventyPayloads) {
  const competitorById = new Map(json.competitors.map(c => [c.id, c]));
  const marketById = new Map((json.markets || []).map(m => [m.id, m]));
  const oddById = new Map((json.odds || []).map(o => [o.id, o]));
  const sportById = new Map((json.sports || []).map(s => [s.id, s]));
  const champById = new Map((json.champs || []).map(c => [c.id, c]));

  for (const e of json.events) {
    if (seenIds.has(e.id)) continue;
    seenIds.add(e.id);

    const compIds = e.competitorIds || [];
    if (compIds.length < 2) continue;
    const home = competitorById.get(compIds[0])?.name;
    const away = competitorById.get(compIds[1])?.name;
    if (!home || !away) continue;

    const sport = sportById.get(e.sportId)?.name || `sport_${e.sportId}`;
    const league = champById.get(e.champId)?.name || '';

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
        const selKey = mapAltenarSelection(key, odd, compIds[0], compIds[1]);
        if (selKey) odds[selKey] = price;
      }
      if (Object.keys(odds).length) markets.push({ key, odds });
    }
    if (!markets.length) continue;

    allEvents.push({
      bookId: `vegas-${e.id}`,
      sport, league, home, away,
      startUtc: e.startDate,
      markets
    });
  }
}

console.log(`Parsed ${allEvents.length} unique events with usable markets.`);
console.log('\nFirst 5:');
for (const ev of allEvents.slice(0, 5)) {
  console.log(`  ${ev.startUtc} ${ev.sport} · ${ev.home} vs ${ev.away}`);
  for (const m of ev.markets) {
    console.log(`    ${m.key}: ${JSON.stringify(m.odds)}`);
  }
}
