// Rediscover the MARKET_GROUP_OVERVIEW (MGO) IDs per sport on tippmixpro.
// Run this if tippmixpro returns 0 matches for a given sport - the operator
// may have rotated MGO IDs. Output goes to stdout; copy the working ones into
// src/scrapers/tippmixpro.js SPORT_MGOS.
//
// Background: the aggregator topic
//   /sports/{partner}/{lang}/highlighted-popular-matches-aggregator-groups-overview/{sportId}/{count}/{mgoIds}/default-event-info/or1.0-100.0
// returns MATCH+MARKET+OUTCOME+BETTING_OFFER records when called with valid
// MGO IDs for that sport. The MGO IDs vary by sport and are not in any
// documented endpoint, so we probe a wide candidate range and accept whatever
// MGOs come back as MARKET_GROUP_OVERVIEW records.
import { WebSocket } from 'ws';

const PARTNER = '2901', LANG = 'hu', REALM = 'www.tippmixpro.hu';
const SPORTS = [1, 3, 6, 7, 8, 9, 20, 22, 28, 49];
// Cover the ranges where existing MGOs were found, plus headroom.
const RANGES = [[500, 800], [1300, 1500], [1500, 2000], [2300, 2500], [2500, 4000]];
const CHUNK = 600; // IDs per CALL - keeps URL well under WAMP limit

const ws = new WebSocket('wss://sportsapi.tippmixpro.hu/v2', ['wamp.2.json'], {
  headers: { 'User-Agent': 'Mozilla/5.0', 'Origin': 'https://www.tippmixpro.hu' }
});
let nextReqId = 1;
const pending = new Map();
const mgosPerSport = new Map();

ws.on('open', () => ws.send(JSON.stringify([1, REALM, { agent:'Wampy.js v6.2.2', roles:{publisher:{features:{}},subscriber:{features:{}},caller:{features:{}},callee:{features:{}}}, authmethods:['wampcra'], authid:'webapi-wampy' }])));

ws.on('message', async raw => {
  const msg = JSON.parse(raw.toString('utf8'));
  if (msg[0] === 2) {
    for (const sport of SPORTS) {
      mgosPerSport.set(sport, []);
      for (const [lo, hi] of RANGES) {
        const ids = [];
        for (let i = lo; i <= hi; i += 1) ids.push(i);
        for (let off = 0; off < ids.length; off += CHUNK) {
          const csv = ids.slice(off, off + CHUNK).join(',');
          const rid = nextReqId++; pending.set(rid, sport);
          ws.send(JSON.stringify([48, rid, {}, '/sports#initialDump', [], {
            topic: `/sports/${PARTNER}/${LANG}/highlighted-popular-matches-aggregator-groups-overview/${sport}/1/${csv}/default-event-info/or1.0-100.0`
          }]));
        }
      }
    }
    setTimeout(() => { report(); ws.close(); process.exit(0); }, 30000);
  } else if (msg[0] === 50) {
    const sport = pending.get(msg[1]); pending.delete(msg[1]);
    for (const r of msg[4]?.records || []) {
      if (r._type === 'MARKET_GROUP_OVERVIEW') {
        const list = mgosPerSport.get(sport);
        if (!list.find(m => m.id === r.id)) list.push({ id: r.id, name: r.translatedName, pos: r.position });
      }
    }
  } else if (msg[0] === 8) {
    pending.delete(msg[2]);
  }
});

function report() {
  console.log('\n=== MGO IDs per sport (paste into SPORT_MGOS in tippmixpro.js) ===\n');
  for (const [sport, mgos] of mgosPerSport) {
    mgos.sort((a,b) => Number(a.pos) - Number(b.pos));
    console.log(`sport ${sport}: ${mgos.length} MGOs`);
    for (const m of mgos) console.log(`  ${String(m.id).padStart(6)}  pos=${m.pos}  ${m.name}`);
  }
}

ws.on('error', err => { console.error(err); process.exit(1); });
