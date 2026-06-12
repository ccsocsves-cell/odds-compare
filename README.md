# odds-compare

Scheduled job that scrapes sports odds from bookmakers reachable from **Hungary** — **vegas.hu**, **tippmixpro.hu**, **22bet** and (optionally) **boabet.com** — clusters the same real-world match across books, and finds **cross-book arbitrage** (2-leg two-way markets and 3-leg 1X2) for matches starting **between 2 hours and 7 days from now**. Fresh arbs above the profit threshold are posted to Discord with an exact stake split; everything else stays silent.

> **Responsible-use caveat.** Tippmixpro and Vegas.hu are the only Hungarian-licensed online sportsbooks; the other scraped books operate under foreign (MGA/Curaçao-style) licences and are not licensed in Hungary. This project only *reads public odds* and posts numbers to a private channel — it places no bets. Whether and where you bet is your decision and your risk (legal, tax, account limitation, withdrawal). Bookmakers also routinely limit or close accounts that bet arb-shaped stakes.

## What lives where

| Piece              | Where                                                                 |
|--------------------|-----------------------------------------------------------------------|
| Source code        | this repo                                                             |
| Execution          | GitHub Actions — cron (20-min peak / hourly off-peak) + manual + `/arbs` Discord slash command |
| Discord trigger    | Cloudflare Worker (free tier) — see `discord-bot/SETUP.md`            |
| Hungarian exit IP  | NordVPN (HU server) via the official `nordvpn` Linux CLI              |
| Alert sink         | Discord webhook (silent unless there's a fresh arb; daily heartbeat)  |
| Alert dedup        | `data/seen-arbs.json`, persisted between CI runs via `actions/cache`  |
| Team-name fixes    | `data/overrides.json` (HU country names → English canonical)          |

## Sources

| Site            | Engine      | Transport          | Endpoint                                            |
|-----------------|-------------|--------------------|-----------------------------------------------------|
| vegas.hu        | Altenar     | axios HTTP         | `hu-sb2frontend-altenar2.biahosted.com`             |
| tippmixpro.hu   | EveryMatrix | `ws` WebSocket     | `wss://sportsapi.tippmixpro.hu/v2` (WAMP v2)        |
| 22bet           | 1xCorp      | axios HTTP         | `<mirror>/service-api/LineFeed/*` (auto-discovered) |
| boabet.com      | Digitain    | Playwright capture | dgiframe (XOR-obfuscated JSON), `ENABLE_BOABET` gate |

Four books, four distinct odds engines — that's the point: arbs only arise where pricing models disagree.

**tippmixpro** is the state-run Hungarian sportsbook (Szerencsejáték Zrt) on EveryMatrix's OMFE widgets. The odds layer is **WAMP v2 over WebSocket** (no REST). One `CALL /sports#initialDump` per sport with **per-sport MGO IDs** hardcoded in `SPORT_MGOS`; the returned `MATCH ← MARKET ← MARKET_OUTCOME_RELATION ← OUTCOME ← BETTING_OFFER` records are joined into canonical events. Geo-blocked outside HU → CI connects NordVPN first.

**22bet** runs the 1xCorp platform. `22bet.com` 308-redirects to the mirror of the day (the scraper follows it only to discover the host), the JSON feed lives at `/service-api/LineFeed/`. Champ walk (`GetChampsZip` → `GetChampZip`) lists games, then one `GetGameZip` per windowed game carries 1X2 + totals + BTTS. Two WAF quirks are handled in `src/scrapers/twentytwobet.js`: query-param **order matters** (`country` must come after `tf`), and request bursts earn HTTP 529 → a global throttle (`BET22_GAP_MS`) plus backoff retries. Aggressive probing gets a temporary IP ban — keep the politeness caps.

**boabet** sits behind Digitain's dgiframe bot wall; the scraper drives a **headed** Chromium under xvfb and XOR-decodes the odds payloads. It flaps when the wall rotates — `ENABLE_BOABET=0` disables it without a deploy.

## Pipeline

1. **Scrape** all sources (each `scrapeSafe` — one dead book never aborts the scan) → normalized events `{ bookId, source, sport, league, home, away, startUtc, markets[] }`.
2. **Cluster** (`src/normalize/events.js#clusterEvents`): the largest source anchors; every other source fuzzy-matches against it (Fuse.js + HU/EN aliases + ±30 min start tolerance + home/away flip detection); leftovers get a second pass so pairs the anchor doesn't carry aren't lost.
3. **Arb** (`src/compare.js#arbsInCluster`): per market, best price per selection across the cluster; arb iff Σ 1/odds < 1 with legs at ≥2 books. Markets: `winner`, `btts`, `ou_2.5` (2-leg) and `1x2` (3-leg). A 2-way *winner* is never crossed with a 3-way *1x2* (the draw would be unhedged).
4. **Alert** (`src/alert/discord.js` + `dedup.js`): only *fresh* arbs ≥ `ALERT_THRESHOLD_PCT` post to Discord (re-alert only when profit improves by `DEDUP_IMPROVE_PCT` pp). No-arb runs are silent except the daily `HEARTBEAT` cron.

## One-time setup

### 1. NordVPN service credentials

The regular NordVPN account email/password does **not** work for headless logins. Open the [NordVPN dashboard](https://my.nordaccount.com/dashboard/nordvpn/) → *Manual setup* → grab the **Access token**.

### 2. Discord webhook

In Discord: *Server settings → Integrations → Webhooks → New webhook.* Copy the URL.

### 3. GitHub secrets

```powershell
gh secret set DISCORD_WEBHOOK_URL --body "<your webhook URL>"
gh secret set NORDVPN_TOKEN --body "<access token>"
```

### 4. First run

In GitHub: *Actions → Odds arbitrage scan → Run workflow.* Check the logs for per-source event counts and the closest near-arbs.

## Local development

```powershell
npm install
npx playwright install chromium  # only for boabet / diag scripts

# From Hungary no VPN is needed; elsewhere connect NordVPN HU first
# (tippmixpro's WS host is geo-blocked outside HU).

npm test           # clustering / arb-math / dedup unit tests
npm run compare:dry  # full scrape + cluster + near-arb table, no Discord post
```

### Diagnostic tools

```powershell
node src/ws-capture.js        # full WAMP frame capture → ws-frames.jsonl
node src/inspect-ws-topics.js # map CALL topics → entity types
node src/verify-join.js       # re-run tippmixpro join offline (no VPN)
node src/inspect-ws.js        # tippmixpro betting types + sport IDs
node src/discover-mgos.js     # rediscover MGO IDs when a sport returns 0
node src/dump-events.js       # pretty-print what each scraper returns
```

## Tuning

- **Time window** — `src/compare.js`: `WINDOW_MIN_MS` / `WINDOW_MAX_MS`. Default 2h–7d.
- **Threshold / top N / stake** — `ALERT_THRESHOLD_PCT`, `ALERT_TOP_N`, `STAKE_BASE` env vars.
- **Dedup** — `DEDUP_IMPROVE_PCT` (re-alert sensitivity), `SEEN_ARBS_PATH`.
- **22bet politeness** — `BET22_MAX_CHAMPS`, `BET22_MAX_GAMES`, `BET22_GAP_MS`, `BET22_BASE`.
- **Team-name aliases** — when the fuzzy matcher misses a real pair, add to `data/overrides.json`.
- **Markets** — `src/scrapers/*` market maps + `src/normalize/markets.js`. Currently 1X2, Winner, O/U 2.5, BTTS.

## Known fragility

- **MGO IDs may rotate** (tippmixpro). That sport returns 0 matches → run `node src/discover-mgos.js`, paste into `SPORT_MGOS`.
- **22bet WAF**: param order, 529 throttling, temp IP bans, mirror rotation — all handled, but ids in `MARKET_MAP` may drift; fix from a `SAVE_SAMPLES=1` capture.
- **NordVPN datacenter IPs can be blocked** by any of the books. Try another HU server, or set `ENABLE_BOABET=0` / lean on the remaining sources.
- **Scheduled workflows auto-disable** after 60 days of repo inactivity — `keepalive.yml` pushes an empty commit twice a month to prevent that.
- **Live odds churn** is excluded by the 2h minimum window — pre-match is stable enough for 20-minute polling.

## What it does not do

- Bet anything for you. Output is informational only.
- Cover live/in-play markets.
- Handle exotic markets (handicaps, player props, etc.).
