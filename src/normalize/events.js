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

// Greedy 1:1 matching of two event lists from different books. Returns
// { a, b } pairs where `b` is reoriented (home/away + 1/2 selections
// flipped) to match `a`'s orientation when the books disagree.
export function matchEvents(eventsA, eventsB) {
  const pairs = [];
  const used = new Set();

  // Pre-canonicalize sports on the candidate side
  const bs = eventsB.map(b => ({ ...b, _sport: canonicalSport(b.sport) }));

  for (const a of eventsA) {
    const aSport = canonicalSport(a.sport);
    const aHome = aliasTeam(a.home);
    const aAway = aliasTeam(a.away);
    const aStart = new Date(a.startUtc).getTime();

    const candidates = bs.filter(b =>
      !used.has(b.bookId) &&
      b._sport && aSport && b._sport === aSport &&
      Math.abs(new Date(b.startUtc).getTime() - aStart) < START_TOL_MS
    );
    if (!candidates.length) continue;

    const fuse = new Fuse(
      candidates.map(c => ({ ...c, homeA: aliasTeam(c.home), awayA: aliasTeam(c.away) })),
      { keys: ['homeA', 'awayA'], includeScore: true, threshold: 0.4 }
    );
    const homeHits = fuse.search(aHome);
    const awayHits = fuse.search(aAway);
    if (!homeHits.length || !awayHits.length) continue;

    const top = homeHits.find(h => awayHits.some(x => x.item.bookId === h.item.bookId));
    if (!top) continue;

    used.add(top.item.bookId);
    const b = isFlipped(aHome, aAway, top.item.homeA, top.item.awayA)
      ? flipEvent(top.item)
      : top.item;
    pairs.push({ a, b });
  }
  return pairs;
}

// Cluster the same real-world match across N sources. Anchor-merge: the
// largest source seeds the clusters and every other source is matched
// against it with the (orientation-aware) pairwise matcher above. Sources
// that the anchor doesn't carry still get paired up in a second pass over
// the leftovers, so e.g. a tippmixpro↔22bet-only match isn't lost just
// because vegas doesn't list it.
//
// In:  [['vegas', events], ['tippmixpro', events], ...]
// Out: [{ sport, league, home, away, startUtc, members: { source: event } }]
//      — only clusters with ≥2 members (cross-book arbs need at least two).
export function clusterEvents(named) {
  const pool = named
    .map(([source, events]) => ({ source, events: [...events] }))
    .filter(s => s.events.length > 0)
    .sort((x, y) => y.events.length - x.events.length);

  const clusters = [];

  // Repeatedly: largest remaining source anchors, the rest match against it.
  // Anything unmatched stays in the pool for the next round, so every source
  // pair gets a chance even when the global anchor doesn't carry the match.
  while (pool.length >= 2) {
    const anchor = pool.shift();
    const byAnchorId = new Map();
    for (const ev of anchor.events) {
      byAnchorId.set(ev.bookId, {
        sport: ev.sport,
        league: ev.league,
        home: ev.home,
        away: ev.away,
        startUtc: ev.startUtc,
        members: { [anchor.source]: ev },
      });
    }

    for (const src of pool) {
      const pairs = matchEvents(anchor.events, src.events);
      const matched = new Set();
      for (const { a, b } of pairs) {
        byAnchorId.get(a.bookId).members[src.source] = b;
        matched.add(b.bookId);
      }
      src.events = src.events.filter(e => !matched.has(e.bookId));
    }

    clusters.push(...[...byAnchorId.values()].filter(c => Object.keys(c.members).length >= 2));

    // Sources with leftovers re-enter the next round, largest first.
    for (let i = pool.length - 1; i >= 0; i--) if (!pool[i].events.length) pool.splice(i, 1);
    pool.sort((x, y) => y.events.length - x.events.length);
  }

  return clusters;
}
