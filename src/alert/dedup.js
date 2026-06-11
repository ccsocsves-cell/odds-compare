import fs from 'node:fs';
import path from 'node:path';

// Cross-run alert de-duplication. The cron rediscovers the same arb every
// 20 minutes until the line moves; without this the Discord channel would be
// wall-to-wall repeats. The seen-store is a small JSON file persisted between
// CI runs via actions/cache — losing it is harmless (worst case: one
// duplicate alert), so there's no need for anything sturdier.

// Stable identity of an arb: event + market + which selection sits at which
// book. Same arb at better odds keeps the same key — re-alerting on improved
// profit is filterNew's job, not the key's.
export function arbKey(a) {
  const legs = a.legs.map(l => `${l.selection}@${l.book}`).sort().join('+');
  return [a.sport, a.home, a.away, a.startUtc, a.market, legs].join('|').toLowerCase();
}

export function loadSeen(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return {};
  }
}

export function saveSeen(file, seen) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(seen, null, 2));
}

// Keep an arb if it was never alerted, or its profit improved by more than
// improvePct percentage points since the last alert.
export function filterNew(arbs, seen, improvePct) {
  return arbs.filter(a => {
    const prev = seen[arbKey(a)];
    return !prev || a.profitPct > prev.profitPct + improvePct;
  });
}

// Record alerted arbs. Keeps the historical max profit so an arb that dips
// and recovers to its old level doesn't re-trigger.
export function markSeen(arbs, seen) {
  for (const a of arbs) {
    const k = arbKey(a);
    seen[k] = {
      profitPct: Math.max(a.profitPct, seen[k]?.profitPct ?? -Infinity),
      startUtc: a.startUtc,
    };
  }
}

// Entries whose event already kicked off can never alert again — drop them
// so the store doesn't grow forever.
export function pruneSeen(seen, now = Date.now()) {
  for (const [k, v] of Object.entries(seen)) {
    if (new Date(v.startUtc).getTime() < now) delete seen[k];
  }
}
