import Fuse from 'fuse.js';
import fs from 'node:fs';
import path from 'node:path';

const overridesPath = path.resolve('data/overrides.json');
const overrides = JSON.parse(fs.readFileSync(overridesPath, 'utf8'));

function aliasTeam(name) {
  return overrides.teams[name.toLowerCase()] || name;
}

// Vegas (Altenar) uses English sport names, tippmixpro (EveryMatrix) uses
// Hungarian. Canonicalize both ends to a single key for the equality check.
const SPORT_ALIASES = {
  football: ['football', 'soccer', 'labdarúgás'],
  tennis: ['tennis', 'tenisz'],
  basketball: ['basketball', 'kosárlabda'],
  ice_hockey: ['ice hockey', 'hockey', 'jégkorong'],
  handball: ['handball', 'kézilabda'],
  baseball: ['baseball'],
  volleyball: ['volleyball', 'röplabda'],
  waterpolo: ['waterpolo', 'water polo', 'vízilabda'],
  futsal: ['futsal'],
  american_football: ['american football', 'amerikai futball'],
  rugby: ['rugby', 'rögbi', 'rögbi unió', 'rugby union', 'rugby league'],
  boxing: ['boxing', 'ökölvívás'],
  mma: ['mma'],
  snooker: ['snooker'],
  darts: ['darts'],
  motorsports: ['motorsports', 'motorsport'],
  cricket: ['cricket', 'krikett'],
  cycling: ['cycling', 'kerékpár'],
  table_tennis: ['table tennis', 'asztalitenisz'],
  golf: ['golf'],
  badminton: ['badminton', 'tollaslabda'],
  efootball: ['e-football', 'e-labdarúgás']
};

export function canonicalSport(rawName) {
  if (!rawName) return null;
  const n = String(rawName).toLowerCase().trim();
  for (const [key, aliases] of Object.entries(SPORT_ALIASES)) {
    if (aliases.includes(n)) return key;
  }
  return null;
}

const START_TOL_MS = 30 * 60 * 1000;

// Bigram Dice similarity — enough to decide which of two name orderings
// lines up better (full fuzzy matching stays Fuse's job).
function dice(a, b) {
  a = String(a).toLowerCase();
  b = String(b).toLowerCase();
  if (a === b) return 1;
  if (a.length < 2 || b.length < 2) return 0;
  const grams = s => {
    const m = new Map();
    for (let i = 0; i < s.length - 1; i++) {
      const g = s.slice(i, i + 2);
      m.set(g, (m.get(g) || 0) + 1);
    }
    return m;
  };
  const A = grams(a);
  const B = grams(b);
  let inter = 0;
  for (const [g, c] of A) if (B.has(g)) inter += Math.min(c, B.get(g));
  return (2 * inter) / (a.length - 1 + b.length - 1);
}

// Some books list certain events in the opposite home/away order (e.g.
// boabet/Digitain shows US-league games away-first while vegas/Altenar is
// home-first). The fuzzy matcher pairs them anyway, but the '1'/'2'
// selections would then refer to opposite teams — which fabricates huge
// fake "arbs". Detect the flip by name similarity and reorient the event.
function isFlipped(aHome, aAway, bHome, bAway) {
  const straight = dice(aHome, bHome) + dice(aAway, bAway);
  const crossed = dice(aHome, bAway) + dice(aAway, bHome);
  return crossed > straight;
}

function flipEvent(e) {
  const swap = obj => {
    if (!obj || !('1' in obj || '2' in obj)) return obj;
    const out = { ...obj, 1: obj['2'], 2: obj['1'] };
    if (out['1'] === undefined) delete out['1'];
    if (out['2'] === undefined) delete out['2'];
    return out;
  };
  return {
    ...e,
    home: e.away,
    away: e.home,
    markets: (e.markets || []).map(m => ({ ...m, odds: swap(m.odds), books: swap(m.books) })),
  };
}

export function matchEvents(vegasEvents, tippEvents) {
  const pairs = [];
  const used = new Set();

  // Pre-canonicalize sports on both sides
  const tipps = tippEvents.map(t => ({ ...t, _sport: canonicalSport(t.sport) }));

  for (const v of vegasEvents) {
    const vSport = canonicalSport(v.sport);
    const vHome = aliasTeam(v.home);
    const vAway = aliasTeam(v.away);
    const vStart = new Date(v.startUtc).getTime();

    const candidates = tipps.filter(t =>
      !used.has(t.bookId) &&
      t._sport && vSport && t._sport === vSport &&
      Math.abs(new Date(t.startUtc).getTime() - vStart) < START_TOL_MS
    );
    if (!candidates.length) continue;

    const fuse = new Fuse(
      candidates.map(c => ({ ...c, homeA: aliasTeam(c.home), awayA: aliasTeam(c.away) })),
      { keys: ['homeA', 'awayA'], includeScore: true, threshold: 0.4 }
    );
    const homeHits = fuse.search(vHome);
    const awayHits = fuse.search(vAway);
    if (!homeHits.length || !awayHits.length) continue;

    const top = homeHits.find(h => awayHits.some(a => a.item.bookId === h.item.bookId));
    if (!top) continue;

    used.add(top.item.bookId);
    const t = isFlipped(vHome, vAway, top.item.homeA, top.item.awayA)
      ? flipEvent(top.item)
      : top.item;
    pairs.push({ vegas: v, tipp: t });
  }
  return pairs;
}
