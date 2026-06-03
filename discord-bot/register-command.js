// One-shot script: register the /arbs slash command with Discord.
// Run once per Discord application (or whenever the command definition changes).
//
// Required environment variables:
//   DISCORD_APP_ID    - "Application ID" from Discord Developer Portal
//   DISCORD_BOT_TOKEN - "Bot Token" from the same portal (Bot tab)
//   DISCORD_GUILD_ID  - (optional) register as a guild command for instant
//                       availability instead of global (which takes ~1 hour)
//
// Usage:
//   $env:DISCORD_APP_ID="..."; $env:DISCORD_BOT_TOKEN="..."; $env:DISCORD_GUILD_ID="..."
//   node register-command.js
import process from 'node:process';

const APP_ID = process.env.DISCORD_APP_ID;
const TOKEN  = process.env.DISCORD_BOT_TOKEN;
const GUILD  = process.env.DISCORD_GUILD_ID;
if (!APP_ID || !TOKEN) {
  console.error('Set DISCORD_APP_ID and DISCORD_BOT_TOKEN before running.');
  process.exit(1);
}

const command = {
  name: 'arbs',
  description: 'Trigger an arbitrage scan of vegas.hu vs tippmixpro.hu',
  type: 1
};

const url = GUILD
  ? `https://discord.com/api/v10/applications/${APP_ID}/guilds/${GUILD}/commands`
  : `https://discord.com/api/v10/applications/${APP_ID}/commands`;

const r = await fetch(url, {
  method: 'POST',
  headers: {
    'Authorization': `Bot ${TOKEN}`,
    'Content-Type': 'application/json'
  },
  body: JSON.stringify(command)
});

const body = await r.text();
console.log(`HTTP ${r.status}`);
console.log(body);
if (!r.ok) process.exit(1);
console.log(`\nCommand /arbs registered ${GUILD ? `in guild ${GUILD}` : 'globally'}.`);
console.log(GUILD ? 'It should appear in Discord immediately.' : 'Global commands take up to 1 hour to propagate.');
