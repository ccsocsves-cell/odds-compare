import { test } from 'node:test';
import assert from 'node:assert/strict';
import { clusterEvents } from '../src/normalize/events.js';
import { arbsInCluster } from '../src/compare.js';
import { arbKey, filterNew, markSeen, pruneSeen } from '../src/alert/dedup.js';

const start = new Date(Date.now() + 24 * 3600 * 1000).toISOString();

function ev(source, home, away, markets, sport = 'Football') {
  return {
    bookId: `${source}-${home}-${away}`,
    source, sport, league: 'Test League', home, away,
    startUtc: start,
    markets,
  };
}

test('clusterEvents: same match across 3 sources, one listed away-first', () => {
  const a = ev('vegas', 'Liverpool', 'Arsenal', [{ key: '1x2', odds: { 1: 2.0, X: 3.4, 2: 3.8 } }]);
  const b = ev('tippmixpro', 'Liverpool FC', 'Arsenal FC', [{ key: '1x2', odds: { 1: 2.1, X: 3.3, 2: 3.6 } }]);
  // flipped order: home/away swapped, odds swapped accordingly
  const c = ev('bet22', 'Arsenal', 'Liverpool', [{ key: '1x2', odds: { 1: 3.9, X: 3.5, 2: 1.95 } }]);

  const clusters = clusterEvents([['vegas', [a]], ['tippmixpro', [b]], ['bet22', [c]]]);
  assert.equal(clusters.length, 1);
  const members = clusters[0].members;
  assert.deepEqual(Object.keys(members).sort(), ['bet22', 'tippmixpro', 'vegas']);
  // bet22 member must be reoriented to the anchor's home/away
  assert.equal(members.bet22.home, 'Liverpool');
  assert.equal(members.bet22.markets[0].odds['1'], 1.95);
  assert.equal(members.bet22.markets[0].odds['2'], 3.9);
});

test('clusterEvents: leftover pass clusters matches the anchor does not carry', () => {
  const anchorOnly = ev('vegas', 'Real Madrid', 'Barcelona', [{ key: '1x2', odds: { 1: 2.5, X: 3.3, 2: 2.7 } }]);
  const b = ev('tippmixpro', 'Ferencváros', 'Újpest', [{ key: '1x2', odds: { 1: 1.8, X: 3.6, 2: 4.4 } }]);
  const c = ev('bet22', 'Ferencvaros', 'Ujpest', [{ key: '1x2', odds: { 1: 1.85, X: 3.5, 2: 4.2 } }]);

  const clusters = clusterEvents([['vegas', [anchorOnly]], ['tippmixpro', [b]], ['bet22', [c]]]);
  // vegas event matches nothing (singleton, dropped); tipp+22bet pair up
  assert.equal(clusters.length, 1);
  assert.deepEqual(Object.keys(clusters[0].members).sort(), ['bet22', 'tippmixpro']);
});

test('arbsInCluster: 3-leg 1x2 arb, stakes sum to STAKE_BASE, equal returns', () => {
  const cluster = {
    sport: 'Football', league: 'L', home: 'A', away: 'B', startUtc: start,
    members: {
      vegas: ev('vegas', 'A', 'B', [{ key: '1x2', odds: { 1: 2.1, X: 3.2, 2: 3.4 } }]),
      tippmixpro: ev('tippmixpro', 'A', 'B', [{ key: '1x2', odds: { 1: 1.9, X: 4.0, 2: 4.0 } }]),
    },
  };
  // best-of: 1@2.1 (vegas), X@4.0 (tipp), 2@4.0 (tipp) → Σ 1/odds ≈ 0.976 < 1
  const arbs = arbsInCluster(cluster);
  assert.equal(arbs.length, 1);
  const arb = arbs[0];
  assert.equal(arb.market, '1x2');
  assert.equal(arb.legs.length, 3);
  assert.ok(arb.profitPct > 2.3 && arb.profitPct < 2.5, `profitPct=${arb.profitPct}`);
  const totalStake = arb.legs.reduce((t, l) => t + l.stake, 0);
  assert.ok(Math.abs(totalStake - arb.totalStake) < 1e-9);
  // every leg pays the same guaranteed return
  for (const l of arb.legs) {
    assert.ok(Math.abs(l.stake * l.odds - arb.guaranteedReturn) < 1e-9);
  }
});

test('arbsInCluster: no arb when all best legs sit at one book', () => {
  const cluster = {
    sport: 'Football', league: 'L', home: 'A', away: 'B', startUtc: start,
    members: {
      vegas: ev('vegas', 'A', 'B', [{ key: 'btts', odds: { yes: 2.2, no: 2.2 } }]),
      tippmixpro: ev('tippmixpro', 'A', 'B', [{ key: 'btts', odds: { yes: 1.8, no: 1.8 } }]),
    },
  };
  assert.equal(arbsInCluster(cluster).length, 0);
});

test('arbsInCluster: 2-way winner never mixes with 3-way 1x2', () => {
  const cluster = {
    sport: 'Basketball', league: 'L', home: 'A', away: 'B', startUtc: start,
    members: {
      // genuine 3-way (with draw) at one book…
      tippmixpro: ev('tippmixpro', 'A', 'B', [{ key: '1x2', odds: { 1: 2.4, X: 14.0, 2: 2.6 } }]),
      // …2-way winner at the other: only one book carries each key → no arbs
      vegas: ev('vegas', 'A', 'B', [{ key: 'winner', odds: { 1: 1.5, 2: 2.6 } }]),
    },
  };
  assert.equal(arbsInCluster(cluster).length, 0);
});

test('dedup: repeat suppressed, improved profit re-alerts, kicked-off pruned', () => {
  const arb = {
    sport: 'Football', home: 'A', away: 'B', startUtc: start, market: 'btts',
    legs: [
      { selection: 'yes', book: 'vegas', odds: 2.1, stake: 50 },
      { selection: 'no', book: 'bet22', odds: 2.1, stake: 50 },
    ],
    profitPct: 1.0,
  };
  const seen = {};
  assert.equal(filterNew([arb], seen, 0.3).length, 1);
  markSeen([arb], seen);
  assert.equal(filterNew([arb], seen, 0.3).length, 0);                       // exact repeat
  assert.equal(filterNew([{ ...arb, profitPct: 1.2 }], seen, 0.3).length, 0); // +0.2 < 0.3
  assert.equal(filterNew([{ ...arb, profitPct: 1.5 }], seen, 0.3).length, 1); // +0.5 > 0.3
  // leg order must not matter for identity
  const swapped = { ...arb, legs: [arb.legs[1], arb.legs[0]] };
  assert.equal(arbKey(swapped), arbKey(arb));
  // prune once the event kicked off
  pruneSeen(seen, new Date(start).getTime() + 1000);
  assert.deepEqual(seen, {});
});
