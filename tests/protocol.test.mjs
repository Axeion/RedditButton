/**
 * End-to-end protocol test. Drives real WebSocket clients against a running
 * server and a real Postgres, exercising the game rules and every anti-abuse
 * control.
 *
 *   npm run dev:server      # in one shell
 *   node tests/protocol.test.mjs
 *
 * Makes no assumption about where the shared clock happens to be when it
 * starts — expectations are derived from what the server reports, and the
 * deadline is moved directly in the database to test the edges without waiting
 * ninety seconds for each one.
 */
import WebSocket from 'ws';
import pg from 'pg';

const BASE = process.env.TEST_BASE ?? 'http://localhost:3000';
const WSU = BASE.replace(/^http/, 'ws') + '/ws';
const DB = process.env.DATABASE_URL ?? 'postgres://postgres@127.0.0.1:5433/deadman';

const pool = new pg.Pool({ connectionString: DB });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const results = [];
function check(name, pass, detail = '') {
  results.push({ name, pass, detail });
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
}

async function identity(ua) {
  const res = await fetch(`${BASE}/api/identity`, { headers: { 'user-agent': ua } });
  const body = await res.json();
  const cookie = (res.headers.get('set-cookie') ?? '').split(';')[0];
  return { ok: res.ok, body, cookie, ua };
}

function connect(id, label) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(WSU, { headers: { cookie: id.cookie ?? '', 'user-agent': id.ua } });
    const msgs = [];
    const waiters = [];
    ws.on('message', (d) => {
      const m = JSON.parse(d.toString());
      msgs.push(m);
      for (let i = waiters.length - 1; i >= 0; i--) {
        if (waiters[i].pred(m)) {
          waiters[i].resolve(m);
          waiters.splice(i, 1);
        }
      }
    });
    const client = {
      label,
      ws,
      msgs,
      mark: () => msgs.length,
      /** Only considers messages at or after index `from`. */
      wait: (pred, from = 0, ms = 6000) =>
        new Promise((res, rej) => {
          const hit = msgs.slice(from).find(pred);
          if (hit) return res(hit);
          waiters.push({ pred, resolve: res });
          const t = setTimeout(() => rej(new Error(`${label}: timeout`)), ms);
          if (t.unref) t.unref();
        }),
      send: (o) => ws.send(JSON.stringify(o)),
      close: () => { try { ws.close(); } catch { /* already gone */ } },
    };
    ws.on('open', () => resolve(client));
    ws.on('error', reject);
  });
}

/** Move the live era's deadline so the edges are testable in seconds. */
async function setSecondsLeft(seconds) {
  await pool.query(
    `UPDATE eras SET expires_at = now() + ($1 || ' milliseconds')::interval
     WHERE ended_at IS NULL`,
    [String(Math.round(seconds * 1000))],
  );
}

// --- Setup ------------------------------------------------------------------

// A fresh user-agent per run, because the identity-minting cap is keyed on
// ip_hash (ip + UA) and a reused UA would hit the 3/hour ceiling on the second
// run and turn these clients into spectators.
const RUN = Date.now().toString(36);
const UA_A = `TestBrowserA-${RUN}/1.0`;

const A = await identity(UA_A);
const B = await identity(`TestBrowserB-${RUN}/1.0`);
console.log(`A = ${A.body.name} | B = ${B.body.name}\n`);

const a = await connect(A, 'A');
const b = await connect(B, 'B');
const helloA = await a.wait((m) => m.type === 'hello');
const helloB = await b.wait((m) => m.type === 'hello');

check('both clients get a real identity', !helloA.spectator && !helloB.spectator,
  `${helloA.name} / ${helloB.name}`);
check('name uses Verb_Noun_### format',
  /^[A-Z][a-z]+_[A-Za-z-]+_\d{3}$/.test(helloA.name), helloA.name);
check('both see the same era and deadline',
  helloA.eraId === helloB.eraId && Math.abs(helloA.expiresAt - helloB.expiresAt) < 250,
  `era ${helloA.eraId}, delta ${Math.abs(helloA.expiresAt - helloB.expiresAt)}ms`);

// --- A presses --------------------------------------------------------------

await setSecondsLeft(42);
await sleep(300);

const markA = a.mark();
const markB = b.mark();
const sentAt = Date.now();
a.send({ type: 'press' });

const pressA = await a.wait((m) => m.type === 'press', markA);
const pressB = await b.wait((m) => m.type === 'press', markB);
const expected = 42 - (Date.now() - sentAt) / 1000;

check('A press reaches B live', pressB.press.name === helloA.name,
  `B saw ${pressB.press.name} at ${pressB.press.secondsLeft}s`);
check('mine flag is per-recipient', pressA.mine === true && pressB.mine === false);
check('server stamps the time (client sent none)',
  Math.abs(pressA.press.secondsLeft - expected) < 1.5,
  `server ${pressA.press.secondsLeft}s vs wall clock ~${expected.toFixed(2)}s`);
check('band matches the time band', pressA.press.band === 'moss',
  `${pressA.press.secondsLeft}s -> ${pressA.press.band}`);
check('deadline resets to a full round',
  Math.abs(pressA.expiresAt - Date.now() - 90_000) < 1500,
  `${((pressA.expiresAt - Date.now()) / 1000).toFixed(1)}s`);

const markDup = a.mark();
a.send({ type: 'press' });
const dup = await a.wait((m) => m.type === 'error', markDup);
check('one press per player', dup.code === 'already_pressed', dup.message);

// --- Clearing cookies -------------------------------------------------------

// Same UA + same IP as A, brand new cookie: exactly what clearing cookies does.
const C = await identity(UA_A);
const c = await connect(C, 'C');
const helloC = await c.wait((m) => m.type === 'hello');
check('clearing cookies mints a different name', helloC.name !== helloA.name, helloC.name);
check('cookie-clear identity is a real player, not a spectator', !helloC.spectator,
  'so the next check tests network dedupe rather than the mint cap');

const markC = c.mark();
c.send({ type: 'press' });
const cErr = await c.wait((m) => m.type === 'error', markC);
check('cookie-clear press blocked by network dedupe',
  cErr.code === 'network_pressed', cErr.message);

// --- Leaderboard + gauge ----------------------------------------------------

const lb = await a.wait((m) => m.type === 'leaderboard' && m.era.length > 0, markA);
check('leaderboard sorts lowest seconds first',
  lb.era.every((p, i, arr) => i === 0 || arr[i - 1].secondsLeft <= p.secondsLeft),
  `${lb.era.length} entries, best ${lb.era[0].secondsLeft}s`);
check('ranks are assigned', lb.era[0].rank === 1);

const g = await a.wait((m) => m.type === 'gauge' && m.gauge.total > 0, markA);
const { rows: bandRows } = await pool.query(
  'SELECT band, count(*)::int AS n FROM presses WHERE era_id = $1 GROUP BY band',
  [helloA.eraId],
);
const dbTotal = bandRows.reduce((s, r) => s + r.n, 0);
check('gauge total matches the database', g.gauge.total === dbTotal,
  `gauge ${g.gauge.total} vs db ${dbTotal}`);
check('gauge per-band counts match the database',
  bandRows.every((r) => g.gauge.counts[r.band] === r.n),
  bandRows.map((r) => `${r.band}=${r.n}`).join(' '));

// --- Chat -------------------------------------------------------------------

const markChat = a.mark();
b.send({ type: 'chat', body: 'anyone still loaded?' });
const chatOnA = await a.wait(
  (m) => m.type === 'chat' && m.message.body === 'anyone still loaded?', markChat);
check('chat propagates B -> A', chatOnA.message.name === helloB.name,
  `${chatOnA.message.name}: ${chatOnA.message.body}`);

const markDupChat = b.mark();
b.send({ type: 'chat', body: 'anyone still loaded?' });
const dupChat = await b.wait((m) => m.type === 'error' && m.code === 'duplicate', markDupChat);
check('duplicate message suppressed', !!dupChat, dupChat.message);

const markFlood = b.mark();
for (let i = 0; i < 30; i++) b.send({ type: 'chat', body: `flood ${i}` });
const limited = await b.wait((m) => m.type === 'error' && m.code === 'rate_limited', markFlood);
await sleep(300);
check('chat flood limited but socket survives',
  b.ws.readyState === WebSocket.OPEN, limited.message);

// --- Close call + gold ------------------------------------------------------

await setSecondsLeft(3.2);
await sleep(200);
// Marks index into each client's own buffer, so A and B need their own.
const markGold = b.mark();
const markGoldA = a.mark();
b.send({ type: 'press' });
const gold = await b.wait((m) => m.type === 'press' && m.mine, markGold);
check('sub-5s press earns gold', gold.press.band === 'gold',
  `${gold.press.secondsLeft}s -> ${gold.press.band}`);
check('sub-10s press flagged as a close call', gold.closeCall === true);

const calls = await a.wait((m) => m.type === 'closeCalls' && m.presses.length > 0, markGoldA);
check('close call lands in the feed', calls.presses.some((p) => p.name === helloB.name),
  `${calls.presses.length} in feed`);

const lb2 = await a.wait(
  (m) => m.type === 'leaderboard' && m.era[0]?.name === helloB.name, markGoldA);
check('gold press takes #1', lb2.era[0].name === helloB.name,
  `#1 ${lb2.era[0].name} at ${lb2.era[0].secondsLeft}s`);

// --- Share card -------------------------------------------------------------

const cardRes = await fetch(`${BASE}/card/${gold.press.id}.png`);
const cardBuf = Buffer.from(await cardRes.arrayBuffer());
const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
check('share card renders a real PNG',
  cardRes.ok && cardBuf.subarray(0, 8).equals(PNG_MAGIC), `${cardBuf.length} bytes`);

const shareHtml = await (await fetch(`${BASE}/p/${gold.press.id}`)).text();
check('share page carries Open Graph tags',
  shareHtml.includes('og:image') && shareHtml.includes(`/card/${gold.press.id}.png`));

// --- Flatline ---------------------------------------------------------------

const markDeath = a.mark();
await setSecondsLeft(-1);
const death = await a.wait((m) => m.type === 'flatline', markDeath, 9000);
check('era flatlines when the clock runs out', death.deadEra.id === helloA.eraId,
  `era ${death.deadEra.id} died after ${Math.round(death.deadEra.durationMs / 1000)}s`);
check('a new era opens', death.eraId > death.deadEra.id, `era ${death.eraId}`);
check('dead era records The Last Hand', death.deadEra.lastHand?.name === helloB.name,
  death.deadEra.lastHand?.name);

const markRefund = a.mark();
a.send({ type: 'press' });
const refunded = await a.wait(
  (m) => (m.type === 'press' && m.mine) || m.type === 'error', markRefund);
check('presses are refunded in the new era', refunded.type === 'press',
  refunded.type === 'press' ? `pressed again at ${refunded.press.secondsLeft}s` : refunded.message);

const grave = await (await fetch(`${BASE}/api/graveyard`)).json();
check('dead era appears in the graveyard',
  grave.eras.some((e) => e.id === death.deadEra.id), `${grave.eras.length} buried`);

// --- Protocol hardening (closes sockets, so it runs last) -------------------

const closedB = new Promise((r) => b.ws.on('close', (code) => r(code)));
b.ws.send(JSON.stringify({ type: 'chat', body: 'x'.repeat(200_000) }));
const bCode = await Promise.race([closedB, sleep(3000).then(() => 'none')]);
check('oversized frame closes the socket', bCode === 1009, `close code ${bCode}`);

const closedC = new Promise((r) => c.ws.on('close', (code) => r(code)));
c.ws.send('not json');
c.ws.send('{"type":"nonsense"}');
c.ws.send('{"type":"press",');
const cCode = await Promise.race([closedC, sleep(3000).then(() => 'none')]);
check('three malformed frames drop the connection', cCode === 1008, `close code ${cCode}`);

// --- Audit trail ------------------------------------------------------------

const { rows: kinds } = await pool.query(
  `SELECT DISTINCT kind FROM abuse_events WHERE created_at > now() - interval '10 minutes'`,
);
const seen = kinds.map((k) => k.kind);
for (const kind of ['press_dup_network', 'chat_duplicate', 'chat_rate', 'ws_malformed']) {
  check(`abuse_events records ${kind}`, seen.includes(kind));
}

a.close();
b.close();
c.close();
await pool.end();

const failed = results.filter((r) => !r.pass);
console.log(`\n${results.length - failed.length}/${results.length} passed`);
if (failed.length) console.log('failed: ' + failed.map((f) => f.name).join(', '));
process.exit(failed.length ? 1 : 0);
