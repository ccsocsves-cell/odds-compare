const MARKET_ALIASES = {
  '1x2': [
    '1x2',
    'match result',
    'fulltime result',
    'full time result',
    'match odds',
    'mérkőzés végeredménye',
    'meccs végeredménye'
  ],
  // 2-way moneyline (no draw) — hockey, baseball, basketball, tennis, etc.
  // Altenar names these "Winner (incl. overtime and penalties)", "Winner (incl. extra innings)", etc.
  'winner': [
    'winner',
    'match winner',
    'moneyline',
    'kétesélyes',
    'győztes'
  ],
  'ou_2.5': [
    'over/under 2.5',
    'total goals 2.5',
    'goals o/u 2.5',
    'over under 2.5',
    'totals 2.5',
    'gólok 2.5',
    'gólok száma 2.5',
    'total 2.5'
  ],
  'btts': [
    'both teams to score',
    'btts',
    'mindkét csapat gólt szerez',
    'mindkét csapat szerez gólt'
  ]
};

export function canonicalMarketKey(rawName) {
  if (!rawName) return null;
  const n = rawName.toLowerCase().trim();
  for (const [key, aliases] of Object.entries(MARKET_ALIASES)) {
    if (aliases.some(a => n === a || n.includes(a))) return key;
  }
  return null;
}

export function canonicalSelection(marketKey, rawName) {
  const r = (rawName || '').toLowerCase().trim();
  if (marketKey === '1x2') {
    if (r === '1' || r.includes('home') || r.includes('hazai')) return '1';
    if (r === 'x' || r.includes('draw') || r.includes('döntetlen')) return 'X';
    if (r === '2' || r.includes('away') || r.includes('vendég')) return '2';
  }
  if (marketKey === 'ou_2.5') {
    if (r.startsWith('over') || r.startsWith('o ') || r.startsWith('felett')) return 'over';
    if (r.startsWith('under') || r.startsWith('u ') || r.startsWith('alatt')) return 'under';
  }
  if (marketKey === 'btts') {
    if (r.startsWith('yes') || r === 'igen') return 'yes';
    if (r.startsWith('no') || r === 'nem') return 'no';
  }
  return null;
}
