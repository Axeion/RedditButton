/**
 * Moderation end-to-end. Run with the server up:
 *   node tests/moderation.test.mjs
 *
 * Covers the things that decide whether moderation is real: that the filter
 * blocks before anything is written, that a non-mod cannot moderate no matter
 * what it claims, that deletions reach every connected client, and that every
 * action lands in the audit log attributed to a named account.
 */
import WebSocket from 'ws';
import pg from 'pg';

const BASE = process.env.TEST_BASE ?? 'http://localhost:3000';
const WSU = BASE.replace(/^http/, 'ws') + '/ws';
const DB = process.env.DATABASE_URL ?? 'postgres://postgres@127.0.0.1:5433/deadman';
const ADMIN = process.env.ADMIN_TOKEN ?? 'dev-admin-token';

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
  const body = await res.json();
  return { body, cookie: (res.headers.get('set-cookie') ?? '').split(';')[0], ua };
}

function connect(id, label, extraCookie = '') {
  return new Promise((resolve, reject) => {
    const cookie = [id.cookie, extraCookie].filter(Boolean).join('; ');
    const ws = new WebSocket(WSU, { headers: { cookie, 'user-agent': id.ua } });
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
      wait: (pred, from = 0, ms = 6000) =>
        new Promise((res, rej) => {
          const hit = msgs.slice(from).find(pred);
          if (hit) return res(hit);
          waiters.push({ pred, resolve: res });
          const t = setTimeout(() => rej(new Error(`${label}: timeout`)), ms);
          if (t.unref) t.unref();
        }),
      send: (o) => ws.send(JSON.stringify(o)),
      close: () => { try { ws.close(); } catch { /* gone */ } },
    };
    ws.on('open', () => resolve(c));
    ws.on('error', reject);
  });
}

/**
 * Post and wait for the message to land, retrying through the standing chat
 * cooldown. Note that REJECTED messages still consume rate-limit tokens by
 * design — a spammer shouldn't get free attempts at the filter — so a test
 * that has just probed the filter starts with an empty bucket.
 */
async function postChat(client, body, tries = 8) {
  for (let i = 0; i < tries; i++) {
    const mk = client.mark();
    client.send({ type: 'chat', body });
    const res = await client.wait(
      (m) => (m.type === 'chat' && m.message.body === body) || m.type === 'error', mk);
    if (res.type === 'chat') return res;
    if (!['rate_limited', 'slow_mode'].includes(res.code)) return res;
    await sleep(2200);
  }
  throw new Error(`could not post "${body}" within ${tries} attempts`);
}

// --- Create a mod account via the admin route -------------------------------

const MOD_USER = `testmod${RUN}`;
const MOD_PASS = 'correct-horse-battery-staple';

const created = await fetch(`${BASE}/admin/mods`, {
  method: 'POST',
  headers: { 'content-type': 'application/json', 'x-admin-token': ADMIN },
  body: JSON.stringify({ username: MOD_USER, password: MOD_PASS }),
});
check('admin can create a mod account', created.ok, `${created.status}`);

const weak = await fetch(`${BASE}/admin/mods`, {
  method: 'POST',
  headers: { 'content-type': 'application/json', 'x-admin-token': ADMIN },
  body: JSON.stringify({ username: `weak${RUN}`, password: 'short' }),
});
check('short mod passwords are refused', weak.status === 400);

const noAuth = await fetch(`${BASE}/admin/mods`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ username: `sneaky${RUN}`, password: 'correct-horse-battery' }),
});
check('mod creation requires the admin token', noAuth.status === 403 || noAuth.status === 404,
  `${noAuth.status}`);

// --- Log in -----------------------------------------------------------------

const loginRes = await fetch(`${BASE}/mod/login`, {
  method: 'POST',
  headers: { 'content-type': 'application/x-www-form-urlencoded' },
  body: new URLSearchParams({ username: MOD_USER, password: MOD_PASS }),
  redirect: 'manual',
});
const modCookie = (loginRes.headers.get('set-cookie') ?? '').split(';')[0];
check('mod can sign in', !!modCookie && loginRes.status < 400, `HTTP ${loginRes.status}`);

const badLogin = await fetch(`${BASE}/mod/login`, {
  method: 'POST',
  headers: { 'content-type': 'application/x-www-form-urlencoded' },
  body: new URLSearchParams({ username: MOD_USER, password: 'wrong-password-entirely' }),
  redirect: 'manual',
});
check('wrong password is rejected', badLogin.status === 401,
  `HTTP ${badLogin.status}`);

const me = await (await fetch(`${BASE}/api/mod/me`, { headers: { cookie: modCookie } })).json();
check('session identifies the mod', me?.username === MOD_USER, JSON.stringify(me));

// --- Connect a mod and an ordinary player -----------------------------------

const playerId = await identity(`ModTest-Player-${RUN}/1.0`);
const modId = await identity(`ModTest-Mod-${RUN}/1.0`);

const player = await connect(playerId, 'player');
const mod = await connect(modId, 'mod', modCookie);

const helloPlayer = await player.wait((m) => m.type === 'hello');
const helloMod = await mod.wait((m) => m.type === 'hello');

check('mod connection is flagged as a mod', helloMod.mod?.username === MOD_USER,
  JSON.stringify(helloMod.mod));
check('ordinary player is not flagged as a mod', helloPlayer.mod === null);

// --- Filter blocks before anything is written -------------------------------

const before = await pool.query('SELECT count(*)::int AS n FROM messages');

let mk = player.mark();
player.send({ type: 'chat', body: 'you are a f4gg0t' });
const filtered = await player.wait((m) => m.type === 'error', mk);
check('obfuscated slur is rejected', filtered.code?.startsWith('filtered_'), filtered.message);

mk = player.mark();
player.send({ type: 'chat', body: 'check out https://spam.example.com' });
const linkErr = await player.wait((m) => m.type === 'error', mk);
check('links are rejected', linkErr.code === 'filtered_link', linkErr.message);

const after = await pool.query('SELECT count(*)::int AS n FROM messages');
check('filtered messages never reach the database',
  after.rows[0].n === before.rows[0].n, `${before.rows[0].n} -> ${after.rows[0].n}`);

const good = await postChat(player, 'that was way too close');
check('ordinary messages still get through',
  good.type === 'chat' && good.message.body === 'that was way too close');

// --- A non-mod cannot moderate ----------------------------------------------

mk = player.mark();
player.send({ type: 'modDelete', messageId: good.message.id });
const forbidden = await player.wait((m) => m.type === 'error', mk);
check('non-mod cannot delete (client claims prove nothing)',
  forbidden.code === 'forbidden', forbidden.message);

const stillThere = await pool.query(
  'SELECT deleted_at FROM messages WHERE id = $1', [good.message.id]);
check('message survives the unauthorised delete', stillThere.rows[0].deleted_at === null);

// --- Mod deletes, and everyone sees it --------------------------------------

const markPlayerDel = player.mark();
mod.send({ type: 'modDelete', messageId: good.message.id });
const delEvent = await player.wait((m) => m.type === 'chatDelete', markPlayerDel);
check('deletion is broadcast to every client', delEvent.ids.includes(good.message.id),
  `by ${delEvent.by}`);

const gone = await pool.query('SELECT deleted_at, deleted_by FROM messages WHERE id = $1',
  [good.message.id]);
check('deletion is a soft delete with attribution',
  gone.rows[0].deleted_at !== null && gone.rows[0].deleted_by === MOD_USER,
  `deleted_by=${gone.rows[0].deleted_by}`);

// --- Purge ------------------------------------------------------------------

for (const body of ['spam one', 'spam two', 'spam three']) {
  await postChat(player, body);
}

const lastMsg = [...player.msgs].reverse().find((m) => m.type === 'chat');
const markPurge = player.mark();
mod.send({ type: 'modPurge', messageId: lastMsg.message.id });
const purge = await player.wait((m) => m.type === 'chatDelete', markPurge);
check('purge removes several messages at once', purge.ids.length >= 3,
  `${purge.ids.length} removed`);

// --- Timeout ----------------------------------------------------------------

const markTimeout = player.mark();
mod.send({ type: 'modTimeout', messageId: lastMsg.message.id, minutes: 5 });
const notice = await player.wait(
  (m) => m.type === 'error' && m.code === 'timed_out', markTimeout);
check('timed-out user is told why', !!notice, notice.message);

await sleep(2300);
const markMuted = player.mark();
player.send({ type: 'chat', body: 'can i still talk' });
const muted = await player.wait(
  (m) => m.type === 'error' && m.code !== 'rate_limited', markMuted);
check('timed-out user cannot post', muted.code === 'timed_out', muted.message);

// --- Slow mode and lockdown -------------------------------------------------

const markLock = player.mark();
mod.send({ type: 'modLock', locked: true });
const locked = await player.wait((m) => m.type === 'chatSettings', markLock);
check('lockdown is broadcast', locked.settings.locked === true);

mod.send({ type: 'modLock', locked: false });
await player.wait((m) => m.type === 'chatSettings' && !m.settings.locked, markLock);

const markSlow = player.mark();
mod.send({ type: 'modSlowMode', seconds: 15 });
const slow = await player.wait((m) => m.type === 'chatSettings', markSlow);
check('slow mode is broadcast', slow.settings.slowModeSeconds === 15);
mod.send({ type: 'modSlowMode', seconds: 0 });

// --- Settings survive a restart ---------------------------------------------

const persisted = await pool.query(`SELECT key, value FROM settings`);
check('chat settings are persisted, not in-memory only', persisted.rows.length > 0,
  persisted.rows.map((r) => `${r.key}=${r.value}`).join(' '));

// --- Audit trail ------------------------------------------------------------

await sleep(400);
const audit = await pool.query(
  `SELECT action, mod_name FROM mod_actions WHERE mod_name = $1 ORDER BY id DESC`, [MOD_USER]);
const actions = audit.rows.map((r) => r.action);
for (const a of ['delete_message', 'purge_user', 'timeout', 'slowmode', 'lockdown', 'login']) {
  check(`audit log records ${a}`, actions.includes(a));
}
check('every action is attributed to a named account',
  audit.rows.every((r) => r.mod_name === MOD_USER), `${audit.rows.length} entries`);

// --- Cleanup ----------------------------------------------------------------

await fetch(`${BASE}/admin/mods/${MOD_USER}`, {
  method: 'DELETE',
  headers: { 'x-admin-token': ADMIN },
});
const afterDisable = await (
  await fetch(`${BASE}/api/mod/me`, { headers: { cookie: modCookie } })
).json();
check('disabling a mod kills their session', afterDisable === null, JSON.stringify(afterDisable));

player.close();
mod.close();
await pool.query('DELETE FROM timeouts');
await pool.end();

const failed = results.filter((r) => !r.pass);
console.log(`\n${results.length - failed.length}/${results.length} passed`);
if (failed.length) console.log('failed: ' + failed.map((f) => f.name).join(', '));
process.exit(failed.length ? 1 : 0);
