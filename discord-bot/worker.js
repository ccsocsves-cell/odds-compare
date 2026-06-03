// Cloudflare Worker: accepts Discord slash-command interactions and triggers
// the odds-compare GitHub Actions workflow via repository_dispatch.
//
// Endpoint: POST /interactions (the URL you paste into the Discord app's
// "Interactions Endpoint URL" field after deploying this Worker).
//
// Required secrets (set with `wrangler secret put <NAME>`):
//   DISCORD_PUBLIC_KEY   - Discord application public key (Ed25519 hex)
//   GITHUB_TOKEN         - PAT with `repo` scope (so we can dispatch the workflow)
//   GITHUB_REPO          - e.g. "ccsocsves-cell/odds-compare"
//   ALLOWED_USER_ID      - (optional) restrict to one Discord user ID

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (request.method === 'GET' && url.pathname === '/') {
      return new Response('odds-compare discord bot is alive', { status: 200 });
    }
    if (request.method !== 'POST' || url.pathname !== '/interactions') {
      return new Response('Not found', { status: 404 });
    }

    // 1. Verify Discord's Ed25519 signature on the raw body
    const sig = request.headers.get('x-signature-ed25519');
    const ts = request.headers.get('x-signature-timestamp');
    const bodyText = await request.text();
    if (!sig || !ts || !(await verifyKey(bodyText, sig, ts, env.DISCORD_PUBLIC_KEY))) {
      return new Response('Bad signature', { status: 401 });
    }

    const interaction = JSON.parse(bodyText);

    // 2. PING handshake (sent once when Discord verifies the endpoint URL)
    if (interaction.type === 1) {
      return Response.json({ type: 1 });
    }

    // 3. APPLICATION_COMMAND (slash command invocation)
    if (interaction.type === 2) {
      const cmdName = interaction.data?.name;
      const userId = interaction.member?.user?.id || interaction.user?.id;

      if (env.ALLOWED_USER_ID && userId !== env.ALLOWED_USER_ID) {
        return Response.json({
          type: 4,
          data: { content: 'Sorry, this command is restricted.', flags: 64 }
        });
      }

      if (cmdName === 'arbs') {
        const r = await fetch(`https://api.github.com/repos/${env.GITHUB_REPO}/dispatches`, {
          method: 'POST',
          headers: {
            'Authorization': `Bearer ${env.GITHUB_TOKEN}`,
            'Accept': 'application/vnd.github+json',
            'X-GitHub-Api-Version': '2022-11-28',
            'User-Agent': 'odds-compare-discord-bot'
          },
          body: JSON.stringify({
            event_type: 'run-arbs',
            client_payload: { invoked_by: userId, ts: Date.now() }
          })
        });
        if (r.ok) {
          return Response.json({
            type: 4,
            data: {
              content: 'Arb scan started. Results will post here in ~3 minutes.',
              flags: 64 // ephemeral - only the invoker sees it
            }
          });
        } else {
          const text = await r.text();
          return Response.json({
            type: 4,
            data: {
              content: `Failed to start workflow: HTTP ${r.status}\n\`${text.slice(0, 200)}\``,
              flags: 64
            }
          });
        }
      }

      return Response.json({
        type: 4,
        data: { content: `Unknown command: ${cmdName}`, flags: 64 }
      });
    }

    return new Response('Unhandled interaction type', { status: 400 });
  }
};

// --- Ed25519 signature verification using Web Crypto ---
// Discord docs: https://discord.com/developers/docs/interactions/overview#setting-up-an-endpoint

async function verifyKey(rawBody, signatureHex, timestamp, publicKeyHex) {
  try {
    const publicKey = await crypto.subtle.importKey(
      'raw',
      hexToBytes(publicKeyHex),
      { name: 'Ed25519', namedCurve: 'Ed25519' },
      false,
      ['verify']
    );
    const message = new TextEncoder().encode(timestamp + rawBody);
    return await crypto.subtle.verify(
      'Ed25519',
      publicKey,
      hexToBytes(signatureHex),
      message
    );
  } catch {
    return false;
  }
}

function hexToBytes(hex) {
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.substr(i * 2, 2), 16);
  return out;
}
