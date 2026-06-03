// Offline verifier: pull every record from data/samples/ws-frames.jsonl and
// run the scraper's join logic on them. Catches schema bugs without burning
// a VPN-bound live WS run.
import fs from 'node:fs';
import * as mod from './scrapers/tippmixpro.js';

if (typeof mod._joinRecordsToEventsForTest !== 'function') {
  console.error('Need to expose _joinRecordsToEventsForTest from tippmixpro.js');
  process.exit(1);
}

const lines = fs.readFileSync('data/samples/ws-frames.jsonl', 'utf8').split('\n').filter(Boolean);
const records = [];
for (const line of lines) {
  let frame;
  try { frame = JSON.parse(line); } catch { continue; }
  const p = frame.payload;
  if (!Array.isArray(p) || p[0] !== 50) continue; // only RESULT messages
  const kwargs = p[4] || {};
  if (Array.isArray(kwargs.records)) records.push(...kwargs.records);
}

console.log(`Loaded ${records.length} records from capture`);
const events = mod._joinRecordsToEventsForTest(records);
console.log(`Joined into ${events.length} events with ≥1 canonical market\n`);

for (const e of events.slice(0, 10)) {
  console.log(`[${e.sport}] ${e.home} vs ${e.away}   (${e.league})`);
  console.log(`  start: ${e.startUtc}`);
  for (const m of e.markets) {
    console.log(`  ${m.key}: ${JSON.stringify(m.odds)}`);
  }
  console.log();
}
if (events.length > 10) console.log(`... and ${events.length - 10} more`);
