// Quick inspector for the WS capture - finds a MATCH record and lists all
// unique bettingTypeIds with their Hungarian names.
import fs from 'node:fs';

const lines = fs.readFileSync('data/samples/ws-frames.jsonl', 'utf8').split('\n').filter(Boolean);
let firstMatch = null;
const bettingTypes = new Map();
const sports = new Map();
const recordTypeCounts = new Map();

for (const line of lines) {
  let frame;
  try { frame = JSON.parse(line); } catch { continue; }
  const p = frame.payload;
  if (!Array.isArray(p)) continue;
  const kwargs = p[p.length - 1];
  if (!kwargs || typeof kwargs !== 'object' || !Array.isArray(kwargs.records)) continue;
  for (const r of kwargs.records) {
    recordTypeCounts.set(r._type, (recordTypeCounts.get(r._type) || 0) + 1);
    if (r._type === 'MATCH' && !firstMatch) firstMatch = r;
    if (r.bettingTypeId != null && r.bettingTypeName) {
      bettingTypes.set(String(r.bettingTypeId), r.bettingTypeName);
    }
    if (r._type === 'SPORT') {
      sports.set(String(r.id), r.name);
    }
  }
}

console.log('=== one MATCH record ===');
console.log(JSON.stringify(firstMatch, null, 2));
console.log('\n=== sports (id → name) ===');
for (const [id, name] of [...sports.entries()].sort((a,b) => +a[0] - +b[0])) {
  console.log(`  ${id.padStart(4)}  ${name}`);
}
console.log('\n=== bettingTypeIds (id → name) ===');
for (const [id, name] of [...bettingTypes.entries()].sort((a,b) => +a[0] - +b[0])) {
  console.log(`  ${id.padStart(6)}  ${name}`);
}
console.log('\n=== record type counts ===');
for (const [t, c] of [...recordTypeCounts.entries()].sort((a,b) => b[1]-a[1])) {
  console.log(`  ${String(c).padStart(5)}  ${t}`);
}
