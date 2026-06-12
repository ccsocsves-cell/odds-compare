# Project continuity — resume from another machine

What you need to know to pick this project back up. Everything cloud-side already keeps running without your PC; this doc covers the rare cases where you want to develop locally or rotate credentials.

## What runs where

| Layer | Where | Touch point |
|-------|-------|-------------|
| Source code | this repo (`ccsocsves-cell/odds-compare`) | `git clone` |
| Workflow execution | GitHub Actions | `.github/workflows/odds.yml` |
| Hungarian exit IP | NordVPN (HU server) on the GH runner | `NORDVPN_TOKEN` GH secret |
| Discord slash command | Cloudflare Worker `odds-compare-bot` | `discord-bot/worker.js` |
| Result delivery | Discord webhook | `DISCORD_WEBHOOK_URL` GH secret |

The Cloudflare Worker, Discord application, NordVPN account, GitHub repo, and webhook all live in the cloud. **None of it depends on a specific physical machine.** Only local development does.

## Resuming on a fresh PC — minimum to develop locally

1. Install Node.js 20+ and Git. (Optional: `gh` CLI, NordVPN client if you want to test scrapers without GH Actions.)
2. `git clone https://github.com/ccsocsves-cell/odds-compare.git`
3. `cd odds-compare && npm install`
4. Create `.env` with values from your password manager (see "Local .env" below)
5. Connect NordVPN to HU server (only needed when running `npm run compare` locally)
6. `npm run compare:dry` — should show ~700 vegas events + ~250 tippmixpro events

Everything else (workflow, Discord bot, secrets) already works in the cloud.

## Resuming as "use it from Discord" — nothing to do

The workflow now also runs on **cron** (every 20 min during 14–21 UTC, hourly off-peak, daily heartbeat at 8:07 UTC) and posts to Discord **only when it finds fresh arbs** — silence means "scanned, nothing actionable", and the daily heartbeat confirms the pipeline is alive. `/arbs` in Discord still forces an immediate scan from any device. No PC needed.

The repo is **public** (that's what makes unlimited Actions minutes free). Secrets stay in GH/Worker secret stores; `keepalive.yml` pushes an empty commit twice a month so GitHub never auto-disables the schedules.

## Local `.env`

Gitignored, so it does not travel with `git clone`. Recreate as:

```ini
DISCORD_WEBHOOK_URL=<copy from password manager>
ALERT_THRESHOLD_PCT=0.5
ALERT_TOP_N=10
STAKE_BASE=100
```

`DISCORD_WEBHOOK_URL` is the same value that's in the GH secret. If you don't have it saved, generate a fresh webhook in Discord and set both places with the new value.

## All secrets and where they live

### GitHub Actions (`gh secret list --repo ccsocsves-cell/odds-compare`)

| Secret | What it is | Where to regenerate |
|--------|-----------|---------------------|
| `DISCORD_WEBHOOK_URL` | Webhook the workflow POSTs results to | Discord → channel settings → Integrations → Webhooks |
| `NORDVPN_TOKEN` | Access token for headless `nordvpn login` | https://my.nordaccount.com/dashboard/nordvpn/ → Access tokens |

### Cloudflare Worker (`cd discord-bot && npx wrangler secret list`)

| Secret | What it is | Notes |
|--------|-----------|-------|
| `DISCORD_PUBLIC_KEY` | Ed25519 public key for verifying Discord interactions | Discord Developer Portal → your app → General Information → Public Key |
| `GITHUB_TOKEN` | Fine-grained PAT with Contents:write on the repo | https://github.com/settings/personal-access-tokens |
| `GITHUB_REPO` | `ccsocsves-cell/odds-compare` | Literal string |
| `ALLOWED_USER_ID` | (Optional) Discord user ID that may invoke `/arbs` | Right-click yourself in Discord with Dev Mode on → Copy User ID |

To rotate any secret, generate a new value in the source system, then:

```powershell
gh secret set <NAME> --repo ccsocsves-cell/odds-compare
# OR for Worker secrets:
cd D:\cursor\odds-compare\discord-bot
npx wrangler secret put <NAME>
```

Both commands prompt for the value (input hidden), so values never appear in shell history.

## Architecture cheat sheet

```
[Discord client] ──/arbs──> [Cloudflare Worker]
                              │ verifies Ed25519 signature
                              │ POSTs repository_dispatch (event_type=run-arbs)
                              ▼
                          [GitHub API]
                              │ triggers workflow
                              ▼
                  [GitHub Actions runner]   (also fired by cron schedules)
                              │ nordvpn HU / node
                              │ scrapes vegas.hu (Altenar HTTP)
                              │ scrapes tippmixpro.hu (WAMP v2 WebSocket)
                              │ scrapes 22bet (1xCorp LineFeed HTTP)
                              │ scrapes boabet (Digitain, Playwright; ENABLE_BOABET gate)
                              │ clusters events across books, arbs best-of-cluster
                              │ (2-leg winner/btts/ou_2.5 + 3-leg 1x2)
                              │ dedups vs data/seen-arbs.json (actions/cache)
                              │ POSTs only fresh arbs to Discord webhook
                              ▼
                       [Discord channel]
```

## Where the code lives in the repo

| Path | Purpose |
|------|---------|
| `src/scrapers/vegas.js` | Altenar GetUpcoming → events with 1x2 + Total + GG/NG markets |
| `src/scrapers/tippmixpro.js` | WAMP v2 client; per-sport aggregator with discovered MGO IDs |
| `src/scrapers/twentytwobet.js` | 22bet 1xCorp LineFeed; mirror auto-discovery, WAF param-order quirk, throttle |
| `src/scrapers/boabet.js` | Digitain via headed Playwright + XOR decode; `ENABLE_BOABET` gate |
| `src/normalize/events.js` | Sport canonicalization (EN ↔ HU), Fuse.js team match, N-way `clusterEvents` |
| `src/normalize/markets.js` | Canonical market key/selection mapper |
| `src/compare.js` | Orchestrator: scrape all, cluster, arb best-of-cluster, dedup, send |
| `src/alert/discord.js` | Webhook post formatter (arb messages + status summary) |
| `src/alert/dedup.js` | Cross-run alert dedup (seen-arbs store) |
| `test/unit.test.js` | `npm test` — clustering / arb math / dedup |
| `data/overrides.json` | HU country → EN team name aliases (~80 entries) |
| `discord-bot/worker.js` | Cloudflare Worker that handles `/arbs` |
| `discord-bot/SETUP.md` | One-time deployment guide for the Worker + bot |
| `.github/workflows/odds.yml` | The workflow itself |

Diagnostic-only scripts in `src/` (not called by the production pipeline):

| Path | Purpose |
|------|---------|
| `src/ws-capture.js` | Capture WAMP frames to `data/samples/ws-frames.jsonl` (needs Playwright + HU VPN) |
| `src/discover-mgos.js` | Re-discover tippmixpro MGO IDs if they rotate |
| `src/verify-join.js` | Replay WS capture through `joinRecordsToEvents` (no VPN) |
| `src/dump-events.js` | Print both scrapers' current output side by side |
| `src/inspect-ws.js`, `src/inspect-ws-topics.js` | WAMP frame analyzers |

## Known follow-ups (from project memory)

1. **Wait for actual arbs to fire.** Typical bookies run 5-7% overround. Arbs are rare — sporadic mispricings produce 0.5-2% opportunities. The system now reports closest-to-arb on every empty run so you'll see how close the books come.
2. **Basketball 1X2-with-draw vs Winner mismatch.** Tippmixpro's basketball `1x2` has real draw odds (e.g. 14.0). Vegas's 2-way `winner` can't be safely arbed against it because the draw outcome leaves unhedged exposure. Open question: does tippmixpro's basketball 1x2 settle on regulation only (push on draw) or full-time? If push-on-draw, the pair COULD be arbed treating draw as bet-void.
3. **MGO IDs may rotate.** If a sport returns 0 matches in tippmixpro section, run `node src/discover-mgos.js` and paste new IDs into `SPORT_MGOS`.
4. **Tippmixpro per-sport cap.** Currently 200 events per sport. Football and tennis hit the cap. Bump if needed.

## Discord application reference

| Field | Value |
|-------|-------|
| App ID | `1511805667927658526` |
| App portal | https://discord.com/developers/applications/1511805667927658526 |
| Worker URL | `https://odds-compare-bot.ccsocsves.workers.dev` |
| Interactions endpoint | `https://odds-compare-bot.ccsocsves.workers.dev/interactions` |
| Slash command | `/arbs` (registered guild-scoped) |
| Server ID | `1511653757107179560` |

The bot only needs the `applications.commands` OAuth scope. Re-install via https://discord.com/api/oauth2/authorize?client_id=1511805667927658526&scope=applications.commands if it ever falls out of the server.
