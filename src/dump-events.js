// Dump what each scraper returns so we can see why pairing returns 0.
import { scrapeVegas } from './scrapers/vegas.js';
import { scrapeTippmixpro } from './scrapers/tippmixpro.js';
import { canonicalSport } from './normalize/events.js';

const v = await scrapeVegas();
const t = await scrapeTippmixpro();

const dump = (label, events) => {
  console.log(`\n=== ${label} (${events.length} events) ===`);
  for (const e of events) {
    console.log(`  [${canonicalSport(e.sport) || e.sport}] ${e.home} vs ${e.away}   @ ${e.startUtc}   markets: ${e.markets.map(m => m.key).join(',')}`);
  }
};

dump('VEGAS', v);
dump('TIPPMIXPRO', t);
