// Spike runner: scrape both sites with SAVE_SAMPLES=1 so the raw JSON XHR
// payloads land in data/samples/ for inspection. Use this once to verify the
// parser heuristics in scrapers/*.js match the actual backend shapes.
process.env.SAVE_SAMPLES = '1';
import('./scrapers/vegas.js').then(async ({ scrapeVegas }) => {
  console.log('SPIKE: vegas.hu');
  const v = await scrapeVegas();
  console.log(`  vegas events parsed: ${v.length}`);
  console.log('SPIKE: boabet');
  const { scrapeBoabet } = await import('./scrapers/boabet.js');
  const b = await scrapeBoabet();
  console.log(`  boabet events parsed: ${b.length}`);
  console.log('\nSamples saved to data/samples/. Inspect them and adjust parsers in src/scrapers/*.js.');
});
