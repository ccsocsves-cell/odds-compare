// Diagnostic for the boabet pre-match odds feed. The scraper captures JSON
// XHRs + WS frames but gets only banners/coupon/live-center — never odds.
// Hypotheses to test:
//   a) odds responses have a non-JSON content-type (msgpack/octet-stream)
//   b) odds arrive over a SignalR hub in binary MessagePack (the current
//      String() capture mangles them)
//   c) the pre-match list only loads after clicking a sport in the iframe
// So: capture EVERY response from dgiframe/sportdigi (any content-type),
// log WS traffic both directions losslessly (base64 for binary), click into
// Football inside the iframe, and snapshot the iframe DOM.
import { chromium } from 'playwright';
import fs from 'node:fs';

const ENTRY = 'https://play.boabet-39-eu.com/en/sports/sportsbook/pre-match';
const OUT = 'data/diag-prematch';
fs.mkdirSync(OUT, { recursive: true });

const browser = await chromium.launch({
  headless: false,
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

// --- capture every response from the sportsbook backends, any content-type
let respIdx = 0;
page.on('response', async res => {
  const u = res.url();
  if (!/dgiframe|sportdigi|digitain/i.test(u)) return;
  if (/\.(png|jpg|jpeg|gif|svg|webp|woff2?|css|ttf|ico|mp4|webm|js)(\?|$)/i.test(u)) return;
  const ct = (res.headers()['content-type'] || '').split(';')[0];
  let body;
  try { body = await res.body(); } catch { return; }
  const i = respIdx++;
  console.log(`  [resp ${i}] ${res.status()} ${ct || '-'} ${body.length}B ${u.slice(0, 180)}`);
  if (body.length > 2) {
    const isText = /json|text|xml/i.test(ct);
    fs.writeFileSync(`${OUT}/resp-${i}${isText ? '.json' : '.bin'}`, body);
    fs.appendFileSync(`${OUT}/resp-index.txt`, `${i}\t${res.status()}\t${ct}\t${body.length}B\t${u}\n`);
  }
});

// --- capture WS traffic, both directions, losslessly
const wsLog = fs.createWriteStream(`${OUT}/ws-frames.jsonl`);
page.on('websocket', ws => {
  console.log(`  [ws open] ${ws.url()}`);
  const rec = dir => ev => {
    const p = ev.payload;
    const entry = Buffer.isBuffer(p)
      ? { url: ws.url(), dir, enc: 'base64', payload: p.toString('base64') }
      : { url: ws.url(), dir, enc: 'utf8', payload: String(p) };
    wsLog.write(JSON.stringify(entry) + '\n');
  };
  ws.on('framereceived', rec('recv'));
  ws.on('framesent', rec('sent'));
});

await page.goto(ENTRY, { waitUntil: 'domcontentloaded', timeout: 60000 });
await page.waitForLoadState('networkidle', { timeout: 30000 }).catch(() => {});

const consent = page.locator('#onetrust-accept-btn-handler');
if (await consent.count().catch(() => 0)) {
  await consent.first().click({ timeout: 5000 }).catch(() => {});
  console.log('  accepted OneTrust banner');
}
await page.waitForTimeout(15000);

// --- find the Digitain iframe and poke around inside it
const dgFrame = page.frames().find(f => /dgiframe/.test(f.url()));
console.log(`\nframes: ${page.frames().map(f => f.url().slice(0, 100)).join('\n        ')}`);
if (dgFrame) {
  console.log(`\nDigitain frame found: ${dgFrame.url().slice(0, 160)}`);
  // snapshot the iframe DOM as-is
  fs.writeFileSync(`${OUT}/iframe-initial.html`, await dgFrame.content().catch(() => ''));

  // try to click a Football nav entry to force the match list to load
  const clicks = [
    dgFrame.getByText('Football', { exact: false }).first(),
    dgFrame.locator('[class*=sport i] >> text=/football|labdar/i').first(),
    dgFrame.locator('a,div,li').filter({ hasText: /^(Football|Labdarúgás|Soccer)$/i }).first()
  ];
  for (const c of clicks) {
    try {
      await c.click({ timeout: 8000 });
      console.log('  clicked a Football nav entry');
      break;
    } catch {}
  }
  await page.waitForTimeout(20000);
  fs.writeFileSync(`${OUT}/iframe-after-click.html`, await dgFrame.content().catch(() => ''));
  // quick signal: does the DOM contain decimal odds?
  const txt = await dgFrame.locator('body').innerText().catch(() => '');
  const oddsLike = (txt.match(/\b\d\.\d{2}\b/g) || []).length;
  console.log(`  iframe body text: ${txt.length} chars, ${oddsLike} odds-like numbers`);
  fs.writeFileSync(`${OUT}/iframe-text.txt`, txt);
} else {
  console.log('\nNO dgiframe frame found');
  fs.writeFileSync(`${OUT}/page.html`, await page.content());
}

await browser.close();
wsLog.end();
console.log(`\nDONE → ${OUT}/`);
