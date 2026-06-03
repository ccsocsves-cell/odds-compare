// Find which outbound CALLs / topics carried back MATCH records, so we know
// what to replay in the scraper.
import fs from 'node:fs';

const lines = fs.readFileSync('data/samples/ws-frames.jsonl', 'utf8').split('\n').filter(Boolean);
const callRequestById = new Map();   // requestId → topic
const responseRecordsById = new Map(); // requestId → { types: Set, count }

for (const line of lines) {
  let frame;
  try { frame = JSON.parse(line); } catch { continue; }
  const p = frame.payload;
  if (!Array.isArray(p)) continue;
  const op = p[0];
  if (op === 48 && frame.dir === 'out') {
    // [48, requestId, options, procedure, args, kwargs]
    const reqId = p[1];
    const procedure = p[3];
    const kwargs = p[5] || {};
    callRequestById.set(reqId, { procedure, topic: kwargs.topic });
  } else if (op === 50 && frame.dir === 'in') {
    // [50, requestId, details, args, kwargs]
    const reqId = p[1];
    const kwargs = p[4] || {};
    const records = kwargs.records || [];
    const types = new Set();
    for (const r of records) types.add(r._type);
    responseRecordsById.set(reqId, { types, count: records.length });
  }
}

console.log('=== CALLs that returned MATCH records ===');
for (const [reqId, info] of callRequestById) {
  const resp = responseRecordsById.get(reqId);
  if (resp && resp.types.has('MATCH')) {
    console.log(`req ${reqId}: ${resp.count} records [${[...resp.types].join(',')}]`);
    console.log(`  topic: ${info.topic}`);
  }
}

console.log('\n=== ALL CALLs with their response sizes ===');
for (const [reqId, info] of callRequestById) {
  const resp = responseRecordsById.get(reqId);
  const sz = resp ? `${resp.count} [${[...resp.types].join(',')}]` : 'no response';
  console.log(`req ${reqId}: ${sz}`);
  console.log(`  topic: ${info.topic}`);
}
