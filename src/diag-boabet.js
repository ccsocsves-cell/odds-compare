// Focused diagnostic on the real boabet sportsbook URL. Logs every non-static
// XHR + the page HTML title, so we can see what API the sportsbook uses.
import { chromium } from 'playwright';
import fs from 'node:fs';

const URLS = [
  'https://play.boabet-39-eu.com/en/sport',
  'https://play.boabet-39-eu.com/en/sports',
  'https://play.boabet-39-eu.com/en/sportsbook',
  'https://play.boabet-39-eu.com/en/sport/football'
];

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
    if (/\.(png|jpg|jpeg|gif|svg|webp|woff2?|css|ttf|ico|mp4|webm)(\?|$)/i.test(u)) return;
    if (u.startsWith('data:') || u.startsWith('blob:')) return;
    // Only print JSON or interesting endpoints
    if (ct.includes('json') || /api|sport|odd|event|widget|digitain|graphql/i.test(u)) {
      console.log(`  ${status} [${ct.split(';')[0]}] ${u.slice(0, 220)}`);
    }
  });
  page.on('requestfailed', r => console.log(`  [FAIL] ${r.url().slice(0,200)} - ${r.failure()?.errorText}`));

  try {
    const r = await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 });
    console.log(`  navigated, final URL: ${page.url()}, status: ${r?.status()}`);
    await page.waitForLoadState('networkidle', { timeout: 30000 }).catch(() => {});
    await page.waitForTimeout(15000);
    const title = await page.title();
    console.log(`  title: ${title}`);
    // Save the rendered HTML for inspection
    const slug = url.replace(/[^a-z0-9]+/gi, '_').slice(-50);
    fs.mkdirSync('data/samples', { recursive: true });
    fs.writeFileSync(`data/samples/boabet-html-${slug}.html`, await page.content());
  } catch (err) {
    console.log(`  [NAV ERROR] ${err.message}`);
  } finally {
    await browser.close();
  }
}
console.log('\nDONE. HTML snapshots saved to data/samples/boabet-html-*.html');
