export async function sendDiscord(webhookUrl, arbs) {
  const lines = arbs.map(formatLine);

  if (!webhookUrl) {
    console.log(`\n=== Top ${arbs.length} arbitrage opportunities (dry-run; no webhook) ===`);
    for (const line of lines) console.log(line + '\n');
    return;
  }
  if (!arbs.length) {
    console.log('No arbs above threshold; skipping Discord post.');
    return;
  }

  const header = `**Top ${arbs.length} arbitrage opportunities** (vegas.hu vs tippmixpro.hu)\n`;
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

function formatLine(a) {
  const start = new Date(a.startUtc).toISOString().slice(0, 16).replace('T', ' ');
  const A = a.legA;
  const B = a.legB;
  return (
    `\`${start}Z\` ${a.sport} · **${a.home} vs ${a.away}**` +
    (a.league ? ` _(${a.league})_` : '') + '\n' +
    `  ${a.market} · **+${a.profitPct.toFixed(2)}% guaranteed**` +
    `  ($${a.totalStake.toFixed(0)} → $${a.guaranteedReturn.toFixed(2)})\n` +
    `    └ ${A.book} **${selectionLabel(a.market, A.selection)}** @ ${A.odds.toFixed(2)}` +
    `  stake **$${A.stake.toFixed(2)}**\n` +
    `    └ ${B.book} **${selectionLabel(a.market, B.selection)}** @ ${B.odds.toFixed(2)}` +
    `  stake **$${B.stake.toFixed(2)}**`
  );
}

function selectionLabel(market, sel) {
  if (market === 'winner') {
    if (sel === '1') return 'Home';
    if (sel === '2') return 'Away';
  }
  if (market === 'ou_2.5') {
    if (sel === 'over') return 'Over 2.5';
    if (sel === 'under') return 'Under 2.5';
  }
  if (market === 'btts') {
    if (sel === 'yes') return 'BTTS Yes';
    if (sel === 'no') return 'BTTS No';
  }
  return sel;
}

function chunkLines(header, lines, maxLen) {
  const chunks = [];
  let buf = header;
  for (const line of lines) {
    if ((buf + '\n' + line).length > maxLen) {
      chunks.push(buf);
      buf = line;
    } else {
      buf = buf + '\n\n' + line;
    }
  }
  if (buf.trim().length) chunks.push(buf);
  return chunks;
}
