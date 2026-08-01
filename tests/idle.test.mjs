/**
 * Idle behaviour: pausing, resuming, stale retirement, and cleanup.
 *
 * Run with the server started using a short grace period so the test doesn't
 * have to wait a minute for every transition:
 *
 *   PAUSE_AFTER_EMPTY_SECONDS=3 STALE_PAUSE_HOURS=24 \
 *   NODE_ENV=production node dist/server.js
 *   node tests/idle.test.mjs
 *
 * What's being proven: an unwatched site stops burning eras, remaining time is
 * preserved exactly across a pause, and none of it can cost anyone a press.
 */
import WebSocket from 'ws';
import pg from 'pg';

const BASE = process.env.TEST_BASE ?? 'http://localhost:3000';
const WSU = BASE.replace(/^http/, 'ws') + '/ws';
const DB = process.env.DATABASE_URL ?? 'postgres://postgres@127.0.0.1:5433/deadman';
const ADMIN = process.env.ADMIN_TOKEN ?? 'dev-admin-token';
const GRACE_MS = Number(process.env.PAUSE_AFTER_EMPTY_SECONDS ?? 3) * 1000;

const pool = new pg.Pool({ connectionString: DB });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const RUN = Date.now().toString(36);

const results = [];
function check(name, pass, detail = '') {
  results.push({ name, pass });
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
}

async function identity(ua) {
  const res = await fetch(`${BASE}/api/identity`, { headers: { 'user-agent': ua } });
  return { cookie: (res.headers.get('set-cookie') ?? '').split(';')[0], ua };
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
        if (waiters[i].pred(m)) { waiters[i].resolve(m); waiters.splice(i, 1); }
      }
    });
    const c = {
      label, ws, msgs,
      mark: () => msgs.length,
      wait: (pred, from = 0, ms = 8000) =>
        new Promise((res, rej) => {
          const hit = msgs.slice(from).find(pred);
          if (hit) return res(hit);
          waiters.push({ pred, resolve: res });
          const t = setTimeout(() => rej(new Error(`${label}: timeout`)), ms);
          if (t.unref) t.unref();
        }),
      send: (o) => ws.send(JSON.stringify(o)),
      close: () => new Promise((r) => { ws.once('close', r); ws.close(); }),
    };
    ws.on('open', () => resolve(c));
    ws.on('error', reject);
  });
}

const liveEra = async () => (await pool.query(
  'SELECT id, expires_at, paused_at, started_at FROM eras WHERE ended_at IS NULL ORDER BY id DESC LIMIT 1',
)).rows[0];

const eraCount = async () => Number((await pool.query('SELECT count(*)::int AS n FROM eras')).rows[0].n);

// --- Everyone leaves: the clock must stop -----------------------------------

// Make sure we start from a clean, unwatched state.
await sleep(GRACE_MS + 2500);

const pausedEra = await liveEra();
check('clock pauses when nobody is watching', pausedEra.paused_at !== null,
  pausedEra.paused_at ? `era ${pausedEra.id} paused` : `era ${pausedEra.id} still running`);

const frozenMs = new Date(pausedEra.expires_at) - new Date(pausedEra.paused_at);
const erasBefore = await eraCount();
const idBefore = pausedEra.id;

// This is the whole point: an unwatched site used to burn an era every 90s.
console.log('   … idling for 8s to confirm no era churn');
await sleep(8000);

const erasAfter = await eraCount();
const stillLive = await liveEra();
check('no new eras are created while paused',
  erasAfter === erasBefore && stillLive.id === idBefore,
  `${erasBefore} -> ${erasAfter} eras, era ${idBefore} -> ${stillLive.id}`);
check('the frozen deadline does not drift while paused',
  Math.abs((new Date(stillLive.expires_at) - new Date(stillLive.paused_at)) - frozenMs) < 250,
  `${(frozenMs / 1000).toFixed(2)}s held`);

// --- Someone arrives: the clock resumes where it stopped --------------------

const viewer = await identity(`Idle-${RUN}/1.0`);
const c1 = await connect(viewer, 'viewer');
const hello = await c1.wait((m) => m.type === 'hello');

const resumedRemaining = hello.expiresAt - hello.serverTime;
check('remaining time is preserved across the pause',
  Math.abs(resumedRemaining - frozenMs) < 1500,
  `froze at ${(frozenMs / 1000).toFixed(2)}s, resumed at ${(resumedRemaining / 1000).toFixed(2)}s`);

await sleep(2000);
const running = await liveEra();
check('the clock is running again with a viewer present', running.paused_at === null);

const state = await c1.wait((m) => m.type === 'state' && !m.paused);
check('clients are told the clock is live', state.paused === false,
  `${state.watching} watching`);

// --- Pressing still works normally ------------------------------------------

await pool.query(
  `UPDATE eras SET expires_at = now() + interval '30 seconds' WHERE ended_at IS NULL`);
await sleep(2500);

const markPress = c1.mark();
c1.send({ type: 'press' });
const press = await c1.wait((m) => m.type === 'press' && m.mine, markPress);
check('pausing never costs anyone a press', press.press.secondsLeft > 0,
  `pressed at ${press.press.secondsLeft}s`);

// --- Leaving again re-pauses ------------------------------------------------

await c1.close();
await sleep(GRACE_MS + 2500);
const repaused = await liveEra();
check('clock pauses again when the last viewer leaves', repaused.paused_at !== null);

// --- Stale retirement -------------------------------------------------------

const staleTarget = repaused.id;
await pool.query(
  `UPDATE eras SET paused_at = now() - interval '48 hours' WHERE id = $1`, [staleTarget]);
await sleep(3000);

const afterStale = await liveEra();
check('an era paused past the stale window is retired', afterStale.id !== staleTarget,
  `era ${staleTarget} -> ${afterStale.id}`);

const retired = (await pool.query(
  'SELECT ended_reason FROM eras WHERE id = $1', [staleTarget])).rows[0];
check('a stale era is marked stale, not flatlined', retired?.ended_reason === 'stale',
  `ended_reason=${retired?.ended_reason}`);

check('the replacement era starts paused (still nobody watching)',
  afterStale.paused_at !== null);

// --- The Graveyard only buries real deaths ----------------------------------

const grave = await (await fetch(`${BASE}/api/graveyard`)).json();
const buriedIds = new Set(grave.eras.map((e) => e.id));
check('stale eras stay out of the Graveyard', !buriedIds.has(staleTarget),
  `${grave.eras.length} buried`);

const { rows: reasons } = await pool.query(
  `SELECT DISTINCT ended_reason FROM eras WHERE id = ANY($1::int[])`,
  [[...buriedIds]],
);
check('everything in the Graveyard actually flatlined',
  reasons.every((r) => r.ended_reason === 'flatline'),
  reasons.map((r) => r.ended_reason).join(',') || 'none buried yet');

// --- Cleanup ----------------------------------------------------------------

const pressesBefore = Number((await pool.query('SELECT count(*)::int AS n FROM presses')).rows[0].n);

const cleanupRes = await fetch(`${BASE}/admin/cleanup`, {
  method: 'POST',
  headers: { 'x-admin-token': ADMIN },
});
const cleanup = await cleanupRes.json();
check('cleanup runs', cleanupRes.ok, JSON.stringify(cleanup.report));

const pressesAfter = Number((await pool.query('SELECT count(*)::int AS n FROM presses')).rows[0].n);
check('cleanup never deletes a press', pressesAfter === pressesBefore,
  `${pressesBefore} -> ${pressesAfter}`);

const orphanEmpty = Number((await pool.query(
  `SELECT count(*)::int AS n FROM eras e
   WHERE e.ended_at IS NOT NULL AND e.ended_at < now() - interval '1 hour'
     AND NOT EXISTS (SELECT 1 FROM presses p WHERE p.era_id = e.id)
     AND NOT EXISTS (SELECT 1 FROM messages m WHERE m.era_id = e.id)`,
)).rows[0].n);
check('empty eras are pruned', orphanEmpty === 0, `${orphanEmpty} left`);

const liveStillThere = await liveEra();
check('cleanup leaves the live era alone', !!liveStillThere, `era ${liveStillThere?.id}`);

await pool.end();

const failed = results.filter((r) => !r.pass);
console.log(`\n${results.length - failed.length}/${results.length} passed`);
if (failed.length) console.log('failed: ' + failed.map((f) => f.name).join(', '));
process.exit(failed.length ? 1 : 0);
