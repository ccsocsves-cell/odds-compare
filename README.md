# odds-compare

Hourly job that compares sports odds between **vegas.hu** and **tippmixpro.hu**, finds the biggest implied-probability gaps for matches starting **between 2 hours and 7 days from now**, and posts the top N to a Discord channel.

## What lives where

| Piece              | Where                                                       |
|--------------------|-------------------------------------------------------------|
| Source code        | this repo                                                   |
| Cron + execution   | GitHub Actions, hourly                                      |
| Hungarian exit IP  | NordVPN (HU server) via the official `nordvpn` Linux CLI    |
| Alert sink         | Discord webhook                                             |
| Team-name fixes    | `data/overrides.json` (HU country names → English canonical) |

## How each side is fetched

| Site            | Transport          | Endpoint                                            |
|-----------------|--------------------|-----------------------------------------------------|
| vegas.hu        | axios HTTP         | `hu-sb2frontend-altenar2.biahosted.com` (Altenar)   |
| tippmixpro.hu   | `ws` WebSocket     | `wss://sportsapi.tippmixpro.hu/v2` (WAMP v2)        |

`tippmixpro` is a state-run Hungarian sportsbook (Szerencsejáték Zrt) running EveryMatrix's OMFE widgets. The odds layer is **WAMP v2 over WebSocket** (no REST). The scraper makes one `CALL /sports#initialDump` per sport against `highlighted-popular-matches-aggregator-groups-overview/{sportId}/{count}/{mgoIds}/default-event-info/or1.0-100.0` with **per-sport Market Group Overview (MGO) IDs** hardcoded in `SPORT_MGOS` (10 sports, 4-11 MGOs each, ~258 events per scrape). It then joins the returned `MATCH ← MARKET ← MARKET_OUTCOME_RELATION ← OUTCOME ← BETTING_OFFER` records into canonical events.

The previous boabet.com scraper hit a Cloudflare Turnstile wall on the Digitain iframe and is kept on disk (`src/scrapers/boabet.js`, `src/diag-boabet.js`) for reference only — not called by `compare.js`.

## One-time setup

### 1. NordVPN service credentials

The regular NordVPN account email/password does **not** work for headless logins. Open the [NordVPN dashboard](https://my.nordaccount.com/dashboard/nordvpn/) → *Manual setup* → either grab the **Access token** or the **service-credentials** username/password.

### 2. Discord webhook

In Discord: *Server settings → Integrations → Webhooks → New webhook.* Copy the URL.

### 3. GitHub repo + secrets

```powershell
gh repo create odds-compare --private --source . --remote origin --push
gh secret set DISCORD_WEBHOOK_URL --body "<your webhook URL>"
# Pick ONE of:
gh secret set NORDVPN_TOKEN --body "<access token>"
# OR:
gh secret set NORDVPN_USER --body "<service username>"
gh secret set NORDVPN_PASS --body "<service password>"
```

### 4. First run

In GitHub: *Actions → Hourly odds comparison → Run workflow.* After it finishes you should see a Discord post (or "No gaps above threshold").

## Local development

```powershell
npm install
npx playwright install chromium  # only needed for the diag scripts

# Local runs require NordVPN HU connected manually (tippmixpro WS host is
# geo-blocked outside HU):
nordvpn connect hu

# dry run (prints top gaps to stdout, no Discord call):
npm run compare:dry
```

### Diagnostic tools

When the parser breaks or you want to inspect the live protocol:

```powershell
# Full WAMP frame capture (in + out, no truncation). Writes ws-frames.jsonl.
node src/ws-capture.js

# Map which CALL topics returned which entity types - useful when adding markets
node src/inspect-ws-topics.js

# Re-run join logic offline against the last capture - no VPN needed
node src/verify-join.js

# Inspect tippmixpro betting types + sport IDs
node src/inspect-ws.js

# Rediscover per-sport MGO IDs if the operator rotates them and scrape
# starts returning 0 matches for a given sport. Output is paste-ready
# for SPORT_MGOS in src/scrapers/tippmixpro.js.
node src/discover-mgos.js

# Pretty-print what each scraper currently returns
node src/dump-events.js
```

## Tuning

- **Time window** — `src/compare.js`: `WINDOW_MIN_MS` / `WINDOW_MAX_MS`. Default 2h–7d.
- **Threshold** — `ALERT_THRESHOLD_PCT` env var (default 3 percentage points of implied-probability gap).
- **Top N** — `ALERT_TOP_N` env var (default 10).
- **Team-name aliases** — when the fuzzy matcher misses a real pair, add to `data/overrides.json`. Mostly HU country names → English canonical (vegas returns English, tippmixpro Hungarian).
- **Markets** — `src/scrapers/tippmixpro.js#MARKET_KEY_BY_BETTING_TYPE` and `src/normalize/markets.js`. Currently 1X2, Winner (2-way), O/U 2.5, BTTS. Extend by mapping more `bettingTypeId`s.
- **Vegas catalog size** — `GetTopEvents` returns only ~24 featured events. To grow it, add a second pass through `widget/GetClickableSportMenu` → per-champ enumeration.

## Known fragility

- **MGO IDs may rotate.** `src/scrapers/tippmixpro.js#SPORT_MGOS` hardcodes the Market Group Overview IDs per sport. If the operator changes them, that sport returns 0 matches. Fix by running `node src/discover-mgos.js` and pasting the new IDs.
- **Vegas catalog is still featured-only.** `GetTopEvents` returns ~24 events. To grow it, add per-champ enumeration via `widget/GetClickableSportMenu` → per-champ events. Currently the binding constraint on pair count.
- **NordVPN datacenter IPs can be blocked** by either bookmaker. Mitigations: try a different HU server (`nordvpn connect <server-name>`), or move to a residential proxy.
- **Live odds churn** is excluded by the 2h minimum window for exactly this reason — pre-match is stable enough for hourly polling.

## What it does not do

- Bet anything for you. Output is informational only.
- Cover live/in-play markets.
- Handle exotic markets (handicaps, player props, etc.) — only 1X2, Winner, O/U 2.5, BTTS by default.
