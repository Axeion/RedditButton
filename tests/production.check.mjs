/**
 * Read-only production verification. Safe to run against the live site.
 *
 *   node tests/production.check.mjs https://deadman.lol
 *
 * Deliberately does NOT press, seed, or touch the database. Pressing would put
 * bot entries on a real leaderboard permanently, and the era-manipulation the
 * full browser suite relies on would kill a live game.
 */
import WebSocket from 'ws';

const BASE = (process.argv[2] ?? 'https://deadman.lol').replace(/\/+$/, '');
const WSU = BASE.replace(/^http/, 'ws') + '/ws';

const IS_HTTPS = BASE.startsWith('https://');

const results = [];
function check(name, pass, detail = '') {
  results.push({ name, pass });
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
}
/** Checks that are only meaningful against a real deployment behind a proxy. */
function skip(name, why) {
  console.log(`SKIP  ${name} — ${why}`);
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// --- Health -----------------------------------------------------------------

const healthRes = await fetch(`${BASE}/healthz`);
const health = await healthRes.json();
check('healthz reports ok', healthRes.ok && health.ok === true, JSON.stringify(health));
check('an era is live', Number.isFinite(health.era), `era ${health.era}`);
if (IS_HTTPS) check('served over TLS', true);
else skip('served over TLS', 'target is http (local run)');
check('no x-powered-by header', !healthRes.headers.get('x-powered-by'));

// --- trust proxy is real, and not spoofable ---------------------------------
//
// The whole anti-abuse layer keys on ip_hash. Two failure modes to rule out:
//   1. trust proxy unset -> every visitor hashes to the proxy's address.
//   2. trust proxy trusting the LEFTMOST X-Forwarded-For entry -> any client
//      can pick their own identity by forging a header.
// We can test #2 from a single network: forging XFF must not move the hash.

const UA = 'ProdCheck-XFF/1.0';
const hashOf = async (headers = {}) =>
  (await (await fetch(`${BASE}/healthz`, { headers: { 'user-agent': UA, ...headers } })).json())
    .ipHashPrefix;

// A dual-stack client alternates between IPv4 and IPv6 via Happy Eyeballs, so
// the honest hash is not one value — it is a small set. Sample it first, then
// check whether forging a header can produce anything OUTSIDE that set. A
// single before/after comparison reads address rotation as a spoof.
const natural = new Set();
for (let i = 0; i < 6; i++) natural.add(await hashOf());

const forgedSet = new Set();
for (let i = 0; i < 6; i++) {
  forgedSet.add(await hashOf({ 'x-forwarded-for': '203.0.113.7' }));
  forgedSet.add(await hashOf({ 'x-forwarded-for': '9.9.9.9, 8.8.8.8, 7.7.7.7' }));
}

const escaped = [...forgedSet].filter((h) => !natural.has(h));

if (IS_HTTPS) {
  check('forged X-Forwarded-For cannot change your ip hash', escaped.length === 0,
    escaped.length === 0
      ? `stable across ${natural.size} source address${natural.size === 1 ? '' : 'es'}: ${[...natural].join(', ')}`
      : `SPOOFABLE — forging produced ${escaped.join(', ')}, outside natural set ${[...natural].join(', ')}`);
  if (natural.size > 1) {
    console.log(`      note: ${natural.size} source addresses seen for one client ` +
      `(dual-stack IPv4/IPv6 is normal; each is a separate ip_hash bucket)`);
  }
} else {
  skip('forged X-Forwarded-For cannot change your ip hash',
    'no proxy in front of a local run; set TRUSTED_PROXY_HOPS=0 if exposing directly');
}

const baseline = [...natural][0];

// A different user-agent must produce a different hash — proves the UA is
// actually mixed in, which is what keeps households from colliding.
const otherUa = (
  await (
    await fetch(`${BASE}/healthz`, { headers: { 'user-agent': 'ProdCheck-Other/1.0' } })
  ).json()
).ipHashPrefix;
check('user-agent is part of the hash', otherUa !== baseline, `${baseline} vs ${otherUa}`);

// --- Identity ---------------------------------------------------------------

const idRes = await fetch(`${BASE}/api/identity`, {
  headers: { 'user-agent': `ProdCheck-${Date.now().toString(36)}/1.0` },
});
const id = await idRes.json();
const cookie = (idRes.headers.get('set-cookie') ?? '').split(';')[0];
const setCookieRaw = idRes.headers.get('set-cookie') ?? '';

check('identity endpoint responds', idRes.ok, id.name ?? JSON.stringify(id));
check('name uses Verb_Noun_### format', /^[A-Z][a-z]+_[A-Za-z-]+_\d{3}$/.test(id.name ?? ''), id.name);
check('identity cookie is HttpOnly', /httponly/i.test(setCookieRaw));
check('identity cookie is Secure in production', /secure/i.test(setCookieRaw));
check('identity cookie is SameSite', /samesite/i.test(setCookieRaw));

// --- Realtime over wss through Railway's proxy ------------------------------
//
// The single riskiest thing in production: a proxy that terminates TLS but
// doesn't upgrade WebSockets would leave the page looking fine and completely
// dead. Verified live, without pressing anything.

const frames = [];
const ws = new WebSocket(WSU, { headers: { cookie, 'user-agent': 'ProdCheck/1.0' } });

const opened = await new Promise((resolve) => {
  ws.on('open', () => resolve(true));
  ws.on('error', () => resolve(false));
  setTimeout(() => resolve(false), 10_000);
});
check('websocket upgrades over wss', opened, WSU);

if (opened) {
  ws.on('message', (d) => {
    const f = JSON.parse(d.toString());
    f._at = Date.now();
    frames.push(f);
  });
  await sleep(3500);

  const hello = frames.find((f) => f.type === 'hello');
  const state = frames.filter((f) => f.type === 'state');
  const board = frames.find((f) => f.type === 'leaderboard');
  const gauge = frames.find((f) => f.type === 'gauge');

  check('server sends hello', !!hello, hello ? `as ${hello.name ?? 'spectator'}` : '');
  // Both values come from the server, so this is immune to local clock skew.
  // Comparing hello.expiresAt against Date.now() would measure the viewer's
  // wristwatch, which is the mistake ClockSync exists to correct for.
  const leftOnServer = hello ? (hello.expiresAt - hello.serverTime) / 1000 : NaN;
  check('deadline broadcast, not a countdown',
    !!hello && typeof hello.expiresAt === 'number' &&
      leftOnServer > 0 && leftOnServer <= hello.roundSeconds + 1,
    Number.isNaN(leftOnServer) ? '' : `${leftOnServer.toFixed(1)}s left (server clock)`);
  check('state frames arrive about once a second', state.length >= 2,
    `${state.length} in 3.5s`);
  check('watching count is live', state.length > 0 && state.at(-1).watching >= 1,
    state.length ? `${state.at(-1).watching} watching, ${state.at(-1).loaded} loaded` : '');
  check('leaderboard pushed on connect', !!board,
    board ? `${board.era.length} this era, ${board.allTime.length} all-time` : '');
  check('gauge pushed on connect', !!gauge, gauge ? `${gauge.gauge.total} presses` : '');

  // Clock sync round trip.
  const t0 = Date.now();
  ws.send(JSON.stringify({ type: 'ping', t: t0 }));
  await sleep(1200);
  const pong = frames.find((f) => f.type === 'pong' && f.t === t0);
  // Skew measured at arrival; sampling after a sleep would just add the sleep.
  const rtt = pong ? pong._at - t0 : 0;
  const skew = pong ? Math.round(pong.serverTime - (t0 + rtt / 2)) : 0;
  check('clock sync ping/pong works', !!pong,
    pong ? `rtt ${rtt}ms, your clock is ${skew > 0 ? 'behind' : 'ahead'} by ${Math.abs(skew)}ms` : '');

  // Oversized frame must be rejected even through the proxy.
  const closed = new Promise((r) => ws.on('close', (c) => r(c)));
  ws.send(JSON.stringify({ type: 'chat', body: 'x'.repeat(200_000) }));
  const code = await Promise.race([closed, sleep(4000).then(() => 'none')]);
  check('oversized frame rejected in production', code === 1009, `close code ${code}`);
}

// --- Pages ------------------------------------------------------------------

const homeHtml = await (await fetch(BASE)).text();
check('home page serves the built client', /assets\/index-[A-Za-z0-9_-]+\.js/.test(homeHtml));

const graveRes = await fetch(`${BASE}/graveyard`);
const graveHtml = await graveRes.text();
check('graveyard renders', graveRes.ok && graveHtml.includes('Graveyard'));

const grave = await (await fetch(`${BASE}/api/graveyard`)).json();
check('graveyard api returns eras', Array.isArray(grave.eras), `${grave.eras?.length ?? 0} buried`);

// Share card on a real press, if one exists yet.
const anyPress = grave.eras?.flatMap((e) => e.top ?? [])[0];
if (anyPress) {
  const shareHtml = await (await fetch(`${BASE}/p/${anyPress.id}`)).text();
  const og = /<meta property="og:image" content="([^"]+)"/.exec(shareHtml)?.[1];
  if (IS_HTTPS) check('share page has an absolute og:image', !!og && /^https:\/\//i.test(og), og);
  else skip('share page has an absolute og:image', `local run gave ${og}`);

  const cardRes = await fetch(`${BASE}/card/${anyPress.id}.png`);
  const buf = Buffer.from(await cardRes.arrayBuffer());
  const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  check('share card renders a real PNG in production',
    cardRes.ok && buf.subarray(0, 8).equals(PNG), `${buf.length} bytes`);
} else {
  console.log('SKIP  share card — no presses recorded yet');
}

// --- Admin must be locked ---------------------------------------------------

const adminRes = await fetch(`${BASE}/admin/abuse`);
check('admin routes reject unauthenticated access',
  adminRes.status === 403 || adminRes.status === 404, `HTTP ${adminRes.status}`);

try { ws.close(); } catch { /* already closed */ }

const failed = results.filter((r) => !r.pass);
console.log(`\n${results.length - failed.length}/${results.length} passed`);
if (failed.length) console.log('failed: ' + failed.map((f) => f.name).join(', '));
process.exit(failed.length ? 1 : 0);
