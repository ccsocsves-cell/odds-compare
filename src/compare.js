import 'dotenv/config';
import { scrapeVegas } from './scrapers/vegas.js';
import { scrapeTippmixpro } from './scrapers/tippmixpro.js';
import { matchEvents } from './normalize/events.js';
import { sendDiscord } from './alert/discord.js';

const DRY = process.argv.includes('--dry-run');
const THRESHOLD = Number(process.env.ALERT_THRESHOLD_PCT ?? 3);
const TOP_N = Number(process.env.ALERT_TOP_N ?? 10);

const now = Date.now();
const WINDOW_MIN_MS = now + 2 * 3600 * 1000;
const WINDOW_MAX_MS = now + 7 * 24 * 3600 * 1000;

function inWindow(e) {
  const t = new Date(e.startUtc).getTime();
  return Number.isFinite(t) && t >= WINDOW_MIN_MS && t <= WINDOW_MAX_MS;
}

const impliedProb = decimal => 1 / decimal;

function gapsBetween(vEvent, tEvent) {
  const out = [];
  for (const vm of vEvent.markets) {
    const tm = tEvent.markets.find(m => m.key === vm.key);
    if (!tm) continue;
    for (const sel of Object.keys(vm.odds)) {
      if (!(sel in tm.odds)) continue;
      const vO = vm.odds[sel];
      const tO = tm.odds[sel];
      if (!(vO > 1) || !(tO > 1)) continue;
      const gapPct = Math.abs(impliedProb(vO) - impliedProb(tO)) * 100;
      if (gapPct >= THRESHOLD) {
        out.push({
          sport: vEvent.sport,
          home: vEvent.home,
          away: vEvent.away,
          startUtc: vEvent.startUtc,
          market: vm.key,
          selection: sel,
          vegasOdds: vO,
          tippmixproOdds: tO,
          gapPct
        });
      }
    }
  }
  return out;
}

async function main() {
  console.log(`Window: ${new Date(WINDOW_MIN_MS).toISOString()} → ${new Date(WINDOW_MAX_MS).toISOString()}`);

  console.log('Scraping vegas.hu …');
  const vegasAll = await scrapeVegas();
  const vegas = vegasAll.filter(inWindow);
  console.log(`  → ${vegasAll.length} total events, ${vegas.length} in window`);

  console.log('Scraping tippmixpro.hu …');
  const tippAll = await scrapeTippmixpro();
  const tipp = tippAll.filter(inWindow);
  console.log(`  → ${tippAll.length} total events, ${tipp.length} in window`);

  console.log('Matching events …');
  const pairs = matchEvents(vegas, tipp);
  console.log(`  → ${pairs.length} matched event pairs`);

  const allGaps = pairs.flatMap(p => gapsBetween(p.vegas, p.tipp));
  allGaps.sort((a, b) => b.gapPct - a.gapPct);
  const top = allGaps.slice(0, TOP_N);
  console.log(`  → ${allGaps.length} gaps ≥ ${THRESHOLD}pp; sending top ${top.length}`);

  await sendDiscord(DRY ? null : process.env.DISCORD_WEBHOOK_URL, top);
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
