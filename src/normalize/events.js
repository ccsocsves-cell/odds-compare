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
    pairs.push({ vegas: v, tipp: top.item });
  }
  return pairs;
}
