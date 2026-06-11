import axios from 'axios';

const BASE = 'https://api.the-odds-api.com/v4';
const KEY = process.env.ODDS_API_KEY;

// Candidate sport keys in priority order. Each run we ask the (free,
// quota-exempt) GET /v4/sports endpoint which sports are currently in
// season and query odds only for the first MAX_KEYS_PER_RUN active ones.
// This is what fixes the "0 events all summer" failure mode: the old
// hardcoded list was 100% European winter leagues, every one of which
// 422s (off-season) from late May to August.
// API usage note: ≤9 keys × 12 runs/day (every 2h) = ~3,240 req/month
// → requires The Odds API basic tier ($4/mo, 10k req). Free tier (500/mo)
// is only enough for manual/once-daily runs.
const CANDIDATE_KEYS = [
  // Tournaments (seasonal, highest liquidity when on)
  { key: 'soccer_fifa_world_cup',           sport: 'Football' },
  { key: 'soccer_uefa_champs_league',       sport: 'Football' },
  { key: 'soccer_uefa_europa_league',       sport: 'Football' },
  // European winter leagues (Aug–May)
  { key: 'soccer_epl',                      sport: 'Football' },
  { key: 'soccer_germany_bundesliga',       sport: 'Football' },
  { key: 'soccer_spain_la_liga',            sport: 'Football' },
  { key: 'soccer_france_ligue_one',         sport: 'Football' },
  { key: 'soccer_italy_serie_a',            sport: 'Football' },
  { key: 'soccer_hungary_nb1',              sport: 'Football' },
  // Summer leagues (roughly Mar–Nov) — cover the European off-season
  { key: 'soccer_usa_mls',                  sport: 'Football' },
  { key: 'soccer_brazil_campeonato',        sport: 'Football' },
  { key: 'soccer_sweden_allsvenskan',       sport: 'Football' },
  { key: 'soccer_norway_eliteserien',       sport: 'Football' },
  { key: 'soccer_finland_veikkausliiga',    sport: 'Football' },
  { key: 'soccer_japan_j_league',           sport: 'Football' },
  // Non-football
  { key: 'basketball_euroleague',           sport: 'Basketball' },
  { key: 'basketball_nba',                  sport: 'Basketball' },
  { key: 'icehockey_sweden_hockey_league',  sport: 'Ice Hockey' },
  { key: 'baseball_mlb',                    sport: 'Baseball' },
];

// Cap odds requests per run so API quota usage stays flat regardless of
// how many candidates happen to be in season.
const MAX_KEYS_PER_RUN = Number(process.env.ODDS_API_MAX_KEYS ?? 9);

export async function scrapeBet365() {
  if (!KEY) {
    console.warn('  [bet365] ODDS_API_KEY not set — skipping bet365 source');
    return [];
  }

  const activeKeys = await fetchActiveSportKeys();
  let selected;
  if (activeKeys === null) {
    // /sports lookup failed — fall back to trying every candidate (422s are cheap: off-season requests don't count against quota)
    selected = CANDIDATE_KEYS.slice(0, MAX_KEYS_PER_RUN);
    console.warn('  [bet365] /sports lookup failed — falling back to first candidates');
  } else {
    selected = CANDIDATE_KEYS.filter(c => activeKeys.has(c.key)).slice(0, MAX_KEYS_PER_RUN);
    const skipped = CANDIDATE_KEYS.length - selected.length;
    console.log(`  bet365: ${selected.length} in-season sports selected (${skipped} candidates off-season/over cap)`);
    if (!selected.length) console.warn('  [bet365] WARNING: no candidate sport is in season — check CANDIDATE_KEYS');
  }

  const all = [];
  for (const { key: sportKey, sport } of selected) {
    const events = await fetchSportOdds(sportKey, sport);
    console.log(`  bet365 ${sportKey}: ${events.length} events`);
    all.push(...events);
  }
  return all;
}

// GET /v4/sports is free (does not count against the request quota) and
// returns every sport key with an `active` flag. null = request failed.
async function fetchActiveSportKeys() {
  try {
    const res = await axios.get(`${BASE}/sports/`, {
      params: { apiKey: KEY },
      timeout: 15_000,
    });
    return new Set((res.data || []).filter(s => s.active).map(s => s.key));
  } catch (err) {
    console.warn(`  [bet365] /sports: ${err.message}`);
    return null;
  }
}

async function fetchSportOdds(sportKey, sportLabel) {
  let res;
  try {
    res = await axios.get(`${BASE}/sports/${sportKey}/odds/`, {
      params: {
        apiKey: KEY,
        regions: 'eu',
        markets: 'h2h,totals',
        bookmakers: 'bet365',
        oddsFormat: 'decimal',
      },
      timeout: 15_000,
    });
  } catch (err) {
    const status = err.response?.status;
    if (status === 422 || status === 404) {
      // Off-season or unknown sport — should be rare now that keys are
      // pre-filtered against /sports, so make it visible instead of silent.
      console.log(`  bet365 ${sportKey}: off-season (${status}), skipped`);
      return [];
    }
    console.warn(`  [bet365] ${sportKey}: ${err.message}`);
    return [];
  }

  const remaining = res.headers['x-requests-remaining'];
  if (remaining !== undefined && Number(remaining) < 20) {
    console.warn(`  [bet365] WARNING: only ${remaining} API requests remaining this month`);
  }

  return parseEvents(res.data || [], sportLabel);
}

function parseEvents(apiEvents, sportLabel) {
  const out = [];
  for (const e of apiEvents) {
    const book = e.bookmakers?.find(b => b.key === 'bet365');
    if (!book) continue;

    const markets = [];
    for (const m of book.markets || []) {
      const parsed = parseMarket(m, e.home_team, e.away_team);
      if (parsed) markets.push(parsed);
    }
    if (!markets.length) continue;

    out.push({
      bookId: `bet365-${e.id}`,
      source: 'bet365',
      sport: sportLabel,
      league: e.sport_title || '',
      home: e.home_team,
      away: e.away_team,
      startUtc: e.commence_time,
      markets,
    });
  }
  return out;
}

function parseMarket(m, homeTeam, awayTeam) {
  if (m.key === 'h2h') {
    const outcomes = m.outcomes || [];
    const drawO = outcomes.find(o => o.name === 'Draw');
    const homeO = outcomes.find(o => o.name === homeTeam) ?? outcomes[0];
    const awayO = outcomes.find(o => o.name === awayTeam) ?? outcomes[1];
    if (!homeO || !awayO) return null;

    if (drawO) {
      // 3-way: football 1X2
      return { key: '1x2', odds: { '1': homeO.price, '2': awayO.price, 'X': drawO.price } };
    }
    // 2-way: basketball/tennis winner
    return { key: 'winner', odds: { '1': homeO.price, '2': awayO.price } };
  }

  if (m.key === 'totals') {
    // Only keep the 2.5 goals line for ou_2.5
    const over  = m.outcomes?.find(o => o.name === 'Over'  && Math.abs(o.point - 2.5) < 0.01);
    const under = m.outcomes?.find(o => o.name === 'Under' && Math.abs(o.point - 2.5) < 0.01);
    if (!over || !under) return null;
    return { key: 'ou_2.5', odds: { over: over.price, under: under.price } };
  }

  return null;
}
