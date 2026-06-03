// Diagnostic spike: prints every XHR URL + status + content-type for both
// sites without saving JSON. Helps figure out the Altenar API URL pattern and
// what's happening with boabet (Cloudflare? non-JSON? redirect?).
import { chromium } from 'playwright';

async function diagSite(label, url, extra = async () => {}) {
  console.log(`\n=== ${label}: ${url} ===`);
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

  page.on('response', res => {
    const u = res.url();
    const ct = res.headers()['content-type'] || '';
    const status = res.status();
    // Only show interesting endpoints, not images / fonts / static assets
    if (/\.(png|jpg|jpeg|gif|svg|webp|woff2?|css|ttf|ico|mp4|webm)(\?|$)/i.test(u)) return;
    if (u.startsWith('data:') || u.startsWith('blob:')) return;
    console.log(`  ${status} [${ct.split(';')[0]}] ${u}`);
  });
  page.on('pageerror', e => console.log(`  [PAGE ERROR] ${e.message}`));
  page.on('requestfailed', r => console.log(`  [FAILED] ${r.url()} - ${r.failure()?.errorText}`));

  try {
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 });
    await page.waitForLoadState('networkidle', { timeout: 30000 }).catch(() => {});
    await page.waitForTimeout(4000);
    await extra(page);
  } catch (err) {
    console.log(`  [NAV ERROR] ${err.message}`);
  } finally {
    await browser.close();
  }
}

await diagSite('VEGAS homepage', 'https://vegas.hu/en/betting');
await diagSite('VEGAS football page', 'https://vegas.hu/en/betting/sport/66', async (page) => {
  // Try clicking the first sport tab if present
  await page.waitForTimeout(3000);
});
await diagSite('BOABET .com', 'https://www.boabet.com/');
await diagSite('BOABET hungary mirror', 'https://boabet-hungary.com/');
await diagSite('BOABET boa-bets mirror', 'https://boa-bets.com/');
