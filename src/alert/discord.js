// Always posts to Discord (no silent skip). When there are no arbs above
// threshold, posts a short "scan complete" status with summary + closest
// near-arb so the user knows the scan ran and what the market looks like.
export async function sendDiscord(webhookUrl, { arbs, summary }) {
  const messages = arbs.length
    ? buildArbMessages(arbs)
    : [buildStatusMessage(summary)];

  if (!webhookUrl) {
    console.log(`\n=== Discord output (dry-run) ===`);
    for (const m of messages) console.log(m + '\n---');
    return;
  }

  for (const content of messages) {
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

const BOOK_LABEL = {
  vegas: 'Vegas.hu', tippmixpro: 'Tippmixpro', boabet: 'Boabet',
};
function bookName(raw) { return BOOK_LABEL[raw] ?? raw; }

function buildArbMessages(arbs) {
  const header = `**${arbs.length} arbitrage opportunit${arbs.length === 1 ? 'y' : 'ies'} found**\n`;
  const lines = arbs.map(formatArbLine);
  return chunkLines(header, lines, 1900);
}

function buildStatusMessage(s) {
  if (!s) return 'Scan complete — no summary available.';

  const src = s.sources ?? {};
  const srcLine = Object.entries(src)
    .map(([k, v]) => `${bookName(k)}: ${v}`)
    .join('  ·  ');

  let msg = `**Scan complete — no arbs above ${s.threshold}% profit threshold.**\n`;
  msg += `> ${srcLine}  ·  matched pairs: ${s.pairCount}\n`;
  msg += `> arb-eligible markets checked (winner / btts / ou_2.5): ${s.eligibleMarketCount}\n`;

  if (s.closest) {
    const start = new Date(s.closest.startUtc).toISOString().slice(0, 16).replace('T', ' ');
    msg += `\n**Closest to arb** (still profit-negative):\n`;
    msg += `\`${start}Z\` ${s.closest.sport} · ${s.closest.home} vs ${s.closest.away}\n`;
    msg += `  ${s.closest.market} · overround **${s.closest.overroundPct.toFixed(2)}%** (need ≤ 0% for arb)`;
  }
  return msg;
}

function formatArbLine(a) {
  const start = new Date(a.startUtc).toISOString().slice(0, 16).replace('T', ' ');
  const A = a.legA;
  const B = a.legB;
  return (
    `\`${start}Z\` ${a.sport} · **${a.home} vs ${a.away}**` +
    (a.league ? ` _(${a.league})_` : '') + '\n' +
    `  ${a.market} · **+${a.profitPct.toFixed(2)}% guaranteed**` +
    `  (€${a.totalStake.toFixed(0)} → €${a.guaranteedReturn.toFixed(2)})\n` +
    `    └ ${bookName(A.book)} **${selectionLabel(a.market, A.selection)}** @ ${A.odds.toFixed(2)}` +
    `  stake **€${A.stake.toFixed(2)}**\n` +
    `    └ ${bookName(B.book)} **${selectionLabel(a.market, B.selection)}** @ ${B.odds.toFixed(2)}` +
    `  stake **€${B.stake.toFixed(2)}**`
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
    if ((buf + '\n\n' + line).length > maxLen) {
      chunks.push(buf);
      buf = line;
    } else {
      buf = buf + '\n\n' + line;
    }
  }
  if (buf.trim().length) chunks.push(buf);
  return chunks;
}
