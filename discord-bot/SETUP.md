# Discord bot setup

Triggers the `odds-compare` GitHub Actions workflow when you type `/arbs` in your Discord server. Runs on Cloudflare Workers (free tier, always-on).

## 1. Create the Discord application

1. Go to <https://discord.com/developers/applications> → **New Application** → name it (e.g. "odds-compare").
2. Copy these three values, you'll need them in the next steps:
   - **General Information → Application ID** (`DISCORD_APP_ID`)
   - **General Information → Public Key** (`DISCORD_PUBLIC_KEY`)
   - **Bot tab → "Reset Token"** → copy the token (`DISCORD_BOT_TOKEN`). You won't see it again — save it.
3. **Installation tab** → **Install Link** → set to "Discord Provided Link" → tick **`applications.commands`** under "Default Install Settings → Scopes". Save.
4. Copy the Install Link from the same page and open it. Choose your server → Authorize. The bot doesn't need any message permissions; slash commands work without them.

## 2. Generate a GitHub Personal Access Token

GitHub Settings → Developer settings → Personal access tokens → **Fine-grained tokens** → Generate new token.

- **Resource owner**: ccsocsves-cell
- **Repository access**: Only select repositories → `odds-compare`
- **Permissions** → Repository permissions → set **Contents** to **Read and write** (this is what the `POST /repos/{owner}/{repo}/dispatches` endpoint needs to fire `repository_dispatch`). `Actions: Read and write` is also fine to add if you want the token usable for other workflow APIs later.

Copy the token. You won't see it again.

## 3. Deploy the Worker

```powershell
cd D:\cursor\odds-compare\discord-bot
npm install -g wrangler         # one-time
wrangler login                  # opens browser, authenticate with Cloudflare account
wrangler deploy
```

Wrangler will print the Worker URL (something like `https://odds-compare-bot.<your-subdomain>.workers.dev`). Save it.

Now set the secrets — wrangler will prompt you to paste each value:

```powershell
wrangler secret put DISCORD_PUBLIC_KEY    # paste the Public Key from step 1.2
wrangler secret put GITHUB_TOKEN          # paste the PAT from step 2
wrangler secret put GITHUB_REPO           # paste:  ccsocsves-cell/odds-compare
wrangler secret put ALLOWED_USER_ID       # (optional) paste your Discord user ID
```

To get your Discord user ID: Discord → User Settings → Advanced → enable **Developer Mode**. Then right-click your name → **Copy User ID**.

## 4. Wire Discord to the Worker

In the Discord Developer Portal for your app:

- **General Information → Interactions Endpoint URL** → paste `<your-worker-url>/interactions` → click **Save**.

Discord will send a PING to verify the endpoint. If the public key in step 3 matches, it saves successfully. If it errors, double-check `DISCORD_PUBLIC_KEY`.

## 5. Register the slash command

```powershell
cd D:\cursor\odds-compare\discord-bot
$env:DISCORD_APP_ID="<app id from step 1.2>"
$env:DISCORD_BOT_TOKEN="<bot token from step 1.2>"
$env:DISCORD_GUILD_ID="<your server id>"   # right-click the server name → Copy Server ID
node register-command.js
```

Guild commands appear immediately. Global commands (omit `DISCORD_GUILD_ID`) take ~1 hour to propagate.

## 6. Try it

In your Discord server, type `/arbs`. The command should appear in the autocomplete. Pick it and send. Within a few seconds you should see an ephemeral reply ("Arb scan started…"), and ~2-3 minutes later the workflow's result (or "no arbs above threshold") will arrive via the existing webhook.

## Updating

If you change `worker.js`: `wrangler deploy` again.

If you change the command definition in `register-command.js`: re-run that script.

## Costs

Cloudflare Workers free tier: 100,000 requests/day. You'll use ~1 request per `/arbs` invocation + 1 Discord PING per Worker restart. Effectively free forever for this use case.

GitHub Actions free tier for private repos: 2,000 minutes/month. Each run is ~3 minutes, so you can trigger ~666 runs/month.
