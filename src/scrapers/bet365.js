import axios from 'axios';

const BASE = 'https://api.the-odds-api.com/v4';
const KEY = process.env.ODDS_API_KEY;

// Curated sport keys to query each run.
// 422 = sport off-season — skipped silently.
// API usage note: 9 keys × 12 runs/day (every 2h) = ~3,240 req/month
// → requires The Odds API basic tier ($4/mo, 10k req). Free tier (500/mo)
// is only enough for manual/once-daily runs.
const SPORT_KEYS = [
  { key: 'soccer_epl',                      sport: 'Football' },
  { key: 'soccer_germany_bundesliga',       sport: 'Football' },
  { key: 'soccer_spain_la_liga',            sport: 'Football' },
  { key: 'soccer_france_ligue_one',         sport: 'Football' },
  { key: 'soccer_italy_serie_a',            sport: 'Football' },
  { key: 'soccer_hungary_nb1',              sport: 'Football' },
  { key: 'soccer_uefa_champs_league',       sport: 'Football' },
  { key: 'basketball_euroleague',           sport: 'Basketball' },
  { key: 'icehockey_sweden_hockey_league',  sport: 'Ice Hockey' },
];

export async function scrapeBet365() {
  if (!KEY) {
    console.warn('  [bet365] ODDS_API_KEY not set — skipping bet365 source');
    return [];
  }
  const all = [];
  for (const { key: sportKey, sport } of SPORT_KEYS) {
    const events = await fetchSportOdds(sportKey, sport);
    if (events.length) console.log(`  bet365 ${sportKey}: ${events.length} events`);
    all.push(...events);
  }
  return all;
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
    if (status === 422 || status === 404) return []; // off-season or unknown sport
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
