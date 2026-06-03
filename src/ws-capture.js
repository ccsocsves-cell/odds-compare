// Capture full WebSocket protocol from tippmixpro's sportsbook so we can
// reverse-engineer the subscribe/request flow and re-implement it in a native
// Node ws client (no Playwright at runtime).
//
// Output: data/samples/ws-frames.jsonl - one frame per line, each line is
//   {ts, dir: 'in'|'out', wsUrl, payload}
// where payload is the parsed JSON array [opcode, requestId, ...].
//
// Run through NordVPN HU. The page takes ~30s to fully populate, but the
// subscribe burst happens in the first 5-10s.
import { chromium } from 'playwright';
import fs from 'node:fs';

// /hu/fogadas/i/ is the sportsbook landing page which auto-subscribes to
// featured matches + sport tree. The /labdarugas category by itself doesn't
// subscribe to anything substantive until a specific league is opened, so we
// only get the WAMP handshake from that URL.
const URL = 'https://www.tippmixpro.hu/hu/fogadas/i/';
const OUT = 'data/samples/ws-frames.jsonl';
const CAPTURE_SECS = 60;

fs.mkdirSync('data/samples', { recursive: true });
fs.writeFileSync(OUT, '');

const browser = await chromium.launch({
  headless: true,
  args: ['--disable-blink-features=AutomationControlled']
});
const ctx = await browser.newContext({
  userAgent:
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
    '(KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36',
  locale: 'hu-HU',
  viewport: { width: 1366, height: 900 }
});
await ctx.addInitScript(() => {
  Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
});
const page = await ctx.newPage();

let frameCount = 0;
const start = Date.now();
const log = (line) => fs.appendFileSync(OUT, JSON.stringify(line) + '\n');

page.on('websocket', ws => {
  const wsUrl = ws.url();
  // Only the sportsbook WS - skip emapi (user account) noise
  if (!/sportsapi\.tippmixpro\.hu/.test(wsUrl)) {
    console.log(`[skip WS] ${wsUrl}`);
    return;
  }
  console.log(`[WS OPEN] ${wsUrl}`);

  const record = (dir, frame) => {
    const raw = typeof frame.payload === 'string'
      ? frame.payload
      : frame.payload?.toString('utf8') ?? '';
    if (!raw) return;
    let payload = raw;
    try { payload = JSON.parse(raw); } catch {}
    log({ ts: Date.now() - start, dir, wsUrl, payload });
    frameCount++;
    // Brief stdout summary so we can see progress
    if (Array.isArray(payload)) {
      const op = payload[0];
      const inner = payload[payload.length - 1];
      const summary = inner && typeof inner === 'object'
        ? (inner.messageType || Object.keys(inner).slice(0, 3).join(','))
        : '';
      console.log(`  ${dir === 'in' ? '<' : '>'} op=${op} ${summary}`.slice(0, 140));
    }
  };

  ws.on('framesent', f => record('out', f));
  ws.on('framereceived', f => record('in', f));
  ws.on('close', () => console.log(`[WS CLOSE] ${wsUrl}`));
});

try {
  console.log(`Navigating to ${URL} ...`);
  await page.goto(URL, { waitUntil: 'domcontentloaded', timeout: 60000 });
  console.log(`Final URL: ${page.url()}`);
  // Wait for the SPA to do its subscribe burst + receive initial dumps
  await page.waitForTimeout(CAPTURE_SECS * 1000);
} catch (err) {
  console.log(`[ERR] ${err.message}`);
} finally {
  await browser.close();
}
console.log(`\nDONE. Captured ${frameCount} frames -> ${OUT}`);
