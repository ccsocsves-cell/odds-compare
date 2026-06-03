// v2: previous diag only loaded the homepage. The actual sportsbook lives at
// /hu/fogadas/i/ and embeds an iframe pointing at sports2.tippmixpro.hu.
// EveryMatrix OMFE widgets engine. Still must run through NordVPN HU.
//
// Saves every JSON XHR body to data/samples/tippmixpro-N-{slug}.json plus
// rendered HTML. Waits 25s per URL so the iframe SPA has time to fetch odds.
import { chromium } from 'playwright';
import fs from 'node:fs';
import path from 'node:path';

const URLS = [
  // Main sportsbook landing (parent page, will inject the iframe)
  'https://www.tippmixpro.hu/hu/fogadas/i/',
  // Specific sport: football. /bajnoksag-kategoria/{slug}/{sportId}
  'https://www.tippmixpro.hu/hu/fogadas/i/bajnoksag-kategoria/labdarugas/',
  // The iframe target directly, in case the parent page blocks something
  'https://sports2.tippmixpro.hu/hu?basePath=https%3A%2F%2Fwww.tippmixpro.hu%2Fhu%2Ffogadas%2Fi'
];

fs.mkdirSync('data/samples', { recursive: true });
// Clear previous tippmixpro samples so we don't mix v1 + v2
for (const f of fs.readdirSync('data/samples')) {
  if (f.startsWith('tippmixpro-')) fs.unlinkSync(path.join('data/samples', f));
}
let savedCount = 0;

for (const url of URLS) {
  console.log(`\n=== ${url} ===`);
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

  page.on('response', async res => {
    const u = res.url();
    const ct = res.headers()['content-type'] || '';
    const status = res.status();
    if (/\.(png|jpg|jpeg|gif|svg|webp|woff2?|css|ttf|ico|mp4|webm|js)(\?|$)/i.test(u)) return;
    if (u.startsWith('data:') || u.startsWith('blob:')) return;
    // Drop noise hosts
    if (/cookielaw|onetrust|google-?analytics|googletagmanager|nr-data|go-mpulse|maze\.co|intercom|fullstory|typeform|safecharge|rgsmatrix\/translations/i.test(u)) return;
    console.log(`  ${status} [${ct.split(';')[0]}] ${u.slice(0, 240)}`);
    if (ct.includes('json') && status >= 200 && status < 300) {
      try {
        const body = await res.text();
        if (body.length > 4 && body.length < 5_000_000) {
          const slug = u.replace(/[^a-z0-9]+/gi, '_').slice(-100);
          const file = path.join('data/samples', `tippmixpro-${savedCount}-${slug}.json`);
          fs.writeFileSync(file, body);
          savedCount++;
        }
      } catch {}
    }
  });
  page.on('requestfailed', r =>
    console.log(`  [FAIL] ${r.url().slice(0, 200)} - ${r.failure()?.errorText}`)
  );
  // also dump websocket frames - EveryMatrix often pushes odds via WS
  page.on('websocket', ws => {
    console.log(`  [WS OPEN] ${ws.url().slice(0, 200)}`);
    ws.on('framereceived', frame => {
      const p = typeof frame.payload === 'string' ? frame.payload : frame.payload?.toString('utf8') ?? '';
      if (p.length > 50 && p.length < 500) console.log(`    [WS<] ${p.slice(0, 200)}`);
    });
  });

  try {
    const r = await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 });
    console.log(`  navigated, final URL: ${page.url()}, status: ${r?.status()}`);
    await page.waitForLoadState('networkidle', { timeout: 30000 }).catch(() => {});
    await page.waitForTimeout(25000);
    const title = await page.title();
    console.log(`  title: ${title}`);
    const slug = url.replace(/[^a-z0-9]+/gi, '_').slice(-60);
    fs.writeFileSync(`data/samples/tippmixpro-html-${slug}.html`, await page.content());
    // Also dump any iframes' final URLs - the real data may load only inside them
    for (const f of page.frames()) {
      if (f === page.mainFrame()) continue;
      console.log(`  [iframe] ${f.url().slice(0, 200)}`);
    }
  } catch (err) {
    console.log(`  [NAV ERROR] ${err.message}`);
  } finally {
    await browser.close();
  }
}
console.log(`\nDONE. Saved ${savedCount} JSON payloads + HTML snapshots to data/samples/`);
