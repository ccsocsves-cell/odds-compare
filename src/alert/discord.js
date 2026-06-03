export async function sendDiscord(webhookUrl, gaps) {
  const lines = gaps.map(formatLine);

  if (!webhookUrl) {
    console.log(`\n=== Top ${gaps.length} odds gaps (dry-run; no webhook) ===`);
    for (const line of lines) console.log(line);
    return;
  }
  if (!gaps.length) {
    console.log('No gaps above threshold; skipping Discord post.');
    return;
  }

  const header = `**Top ${gaps.length} odds gaps** (vegas.hu vs tippmixpro.hu)\n`;
  const chunks = chunkLines(header, lines, 1900);
  for (const content of chunks) {
    const r = await fetch(webhookUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ content })
    });
    if (!r.ok) {
      const body = await r.text();
      throw new Error(`Discord webhook failed: ${r.status} ${body}`);
    }
  }
}

function formatLine(g) {
  const start = new Date(g.startUtc).toISOString().slice(0, 16).replace('T', ' ');
  const better = g.vegasOdds > g.tippmixproOdds ? 'vegas' : 'tippmixpro';
  return (
    `\`${start}Z\` ${g.sport} · **${g.home} vs ${g.away}**\n` +
    `  ${g.market} **${g.selection}**: vegas ${g.vegasOdds} | tippmixpro ${g.tippmixproOdds} ` +
    `→ **${g.gapPct.toFixed(2)}pp** gap (better: ${better})`
  );
}

function chunkLines(header, lines, maxLen) {
  const chunks = [];
  let buf = header;
  for (const line of lines) {
    if ((buf + '\n' + line).length > maxLen) {
      chunks.push(buf);
      buf = line;
    } else {
      buf = buf + '\n' + line;
    }
  }
  if (buf.trim().length) chunks.push(buf);
  return chunks;
}
