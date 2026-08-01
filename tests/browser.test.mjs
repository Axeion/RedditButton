/**
 * Two-browser end-to-end test. Proves the things only a real browser can:
 * that two independent visitors share one clock, that a press in one tab
 * updates the other without a reload, and that the page actually renders.
 *
 *   npm run build && NODE_ENV=production node --env-file=.env dist/server.js
 *   node tests/browser.test.mjs
 *
 * Screenshots land in test-results/.
 */
import { mkdirSync, existsSync } from 'node:fs';
import pg from 'pg';

// Playwright is deliberately NOT a devDependency: it drags ~150MB of browsers
// into every production build for a test that only runs by hand.
let chromium;
try {
  ({ chromium } = await import('playwright'));
} catch {
  console.error('This test needs Playwright:\n\n  npm i --no-save playwright\n');
  process.exit(1);
}

const BASE = process.env.TEST_BASE ?? 'http://localhost:3000';
const DB = process.env.DATABASE_URL ?? 'postgres://postgres@127.0.0.1:5433/deadman';
const OUT = 'test-results';
mkdirSync(OUT, { recursive: true });

const pool = new pg.Pool({ connectionString: DB });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const results = [];
function check(name, pass, detail = '') {
  results.push({ name, pass });
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
}

async function setSecondsLeft(seconds) {
  await pool.query(
    `UPDATE eras SET expires_at = now() + ($1 || ' milliseconds')::interval,
                     paused_at = NULL
     WHERE ended_at IS NULL`,
    [String(Math.round(seconds * 1000))],
  );
  await sleep(2400); // let the server's DB resync pick it up
}

const readClock = (page) => page.locator('#time').innerText().then(Number);

/**
 * Populate the live era with a spread of presses so the leaderboard and gauge
 * have something real to render. The test establishes its own preconditions
 * rather than inheriting whatever the last run left behind — eras roll over,
 * and an era-scoped panel is legitimately empty in a fresh one.
 */
async function seedEra() {
  const names = ['Circling_Magpie_417', 'Howling_Kestrel_204', 'Bluffing_Marmot_733',
    'Drifting_Anvil_118', 'Snarling_Beacon_902', 'Twitching_Gecko_556',
    'Coasting_Heron_341', 'Grinding_Pylon_670', 'Wandering_Thistle_289',
    'Flinching_Comet_845', 'Stalling_Barnacle_063', 'Panting_Turbine_512'];
  const secs = [3.41, 7.88, 14.2, 19.75, 26.3, 33.1, 38.44, 46.9, 55.02, 63.7, 74.15, 86.33];
  const bands = ['gold', 'crimson', 'scarlet', 'scarlet', 'ember', 'amber',
    'amber', 'moss', 'teal', 'steel', 'slate', 'ash'];
  const lines = ['who is still loaded?', 'i am not pressing first', 'that was way too close',
    'hold. hold. HOLD.', 'someone please save it', 'gold or nothing',
    'my hands are sweating', '23 seconds is plenty', 'do NOT let it die',
    'i pressed too early i hate myself', 'this is agony', 'watching this at work'];

  const { rows } = await pool.query(
    'SELECT id FROM eras WHERE ended_at IS NULL ORDER BY id DESC LIMIT 1');
  const era = rows[0].id;

  for (let i = 0; i < names.length; i++) {
    const { rows: u } = await pool.query(
      `INSERT INTO users (name, ip_hash) VALUES ($1, $2)
       ON CONFLICT (name) DO UPDATE SET name = EXCLUDED.name RETURNING id`,
      [names[i], `seed-${i}`]);
    await pool.query(
      `INSERT INTO presses (era_id, user_id, ip_hash, seconds_left, band)
       VALUES ($1, $2, $3, $4, $5) ON CONFLICT DO NOTHING`,
      [era, u[0].id, `seed-${i}`, secs[i], bands[i]]);
    await pool.query('INSERT INTO messages (era_id, user_id, body) VALUES ($1, $2, $3)',
      [era, u[0].id, lines[i]]);
  }
  return era;
}

// Use the environment's pre-installed Chromium rather than downloading one that
// matches this Playwright build. Override with CHROMIUM_PATH if it moves.
const executablePath = process.env.CHROMIUM_PATH ?? '/opt/pw-browsers/chromium';
const browser = await chromium.launch(
  existsSync(executablePath) ? { executablePath } : {},
);

// Two contexts = two cookie jars = two independent players.
const alice = await browser.newContext({
  viewport: { width: 1280, height: 1900 },
  userAgent: `PW-Alice-${Date.now().toString(36)}/1.0`,
});
const bob = await browser.newContext({
  viewport: { width: 1280, height: 1900 },
  userAgent: `PW-Bob-${Date.now().toString(36)}/1.0`,
});

const pa = await alice.newPage();
const pb = await bob.newPage();

await seedEra();
await setSecondsLeft(62);
await Promise.all([pa.goto(BASE), pb.goto(BASE)]);
await pa.waitForFunction(() => document.querySelector('#you')?.textContent?.includes('you are'));
await pb.waitForFunction(() => document.querySelector('#you')?.textContent?.includes('you are'));

const nameA = (await pa.locator('#you').innerText()).replace('you are ', '').trim();
const nameB = (await pb.locator('#you').innerText()).replace('you are ', '').trim();
check('two contexts get two different identities', nameA !== nameB, `${nameA} vs ${nameB}`);

const [ca, cb] = await Promise.all([readClock(pa), readClock(pb)]);
check('both browsers show the same countdown', Math.abs(ca - cb) < 0.6,
  `${ca}s vs ${cb}s (delta ${Math.abs(ca - cb).toFixed(2)}s)`);

check('leaderboard rendered', (await pa.locator('#board li').count()) > 0,
  `${await pa.locator('#board li').count()} rows`);
check('gauge rendered', (await pa.locator('.gauge-seg').count()) > 0,
  `${await pa.locator('.gauge-seg').count()} segments`);
check('chat panel present', (await pa.locator('#chat').count()) === 1);

await pa.screenshot({ path: `${OUT}/01-idle-desktop.png`, fullPage: true });

// --- Alice presses; Bob's clock must jump without a reload ------------------

await setSecondsLeft(8.5);
await pa.waitForFunction(() => Number(document.querySelector('#time')?.textContent) < 12);
await pa.screenshot({ path: `${OUT}/02-urgent.png`, fullPage: false });

const bobBefore = await readClock(pb);
await pa.locator('#press').click();
await pa.waitForSelector('#modal:not([hidden])', { timeout: 5000 });
await sleep(600);
const bobAfter = await readClock(pb);

check('Alice press resets Bob\'s clock with no reload', bobAfter > bobBefore + 60,
  `${bobBefore}s -> ${bobAfter}s`);
check('press modal opens for the presser',
  await pa.locator('#modal .big-time').isVisible());

const modalTime = await pa.locator('#modal .big-time').innerText();
check('modal shows a sub-10s time', Number.parseFloat(modalTime) < 10, modalTime);

const cardImg = pa.locator('#modal img');
await cardImg.waitFor({ state: 'visible' });
const cardOk = await cardImg.evaluate((img) => img.complete && img.naturalWidth > 0);
check('share card image loads', cardOk,
  `${await cardImg.evaluate((i) => `${i.naturalWidth}x${i.naturalHeight}`)}`);

await pa.screenshot({ path: `${OUT}/03-press-modal.png`, fullPage: false });
await pa.locator('#modal-x').click();

check('Alice\'s button is now spent',
  await pa.locator('#press').isDisabled());
check('Bob\'s button is still live',
  !(await pb.locator('#press').isDisabled()));

// --- Chat crosses browsers --------------------------------------------------

const line = `hello from bob ${Date.now().toString(36)}`;
await pb.locator('#chat-input').fill(line);
await pb.locator('#chat-form button').click();
await pa.waitForFunction(
  (t) => document.querySelector('#chat')?.textContent?.includes(t), line, { timeout: 5000 });
check('chat from Bob appears in Alice\'s browser', true, line);

// A visitor who arrives afterwards must be handed the backfill, so the room
// isn't empty for everyone who didn't happen to be watching.
const late = await browser.newContext({ userAgent: `PW-Late-${Date.now().toString(36)}/1.0` });
const pl = await late.newPage();
await pl.goto(BASE);
await pl.waitForSelector('#chat .msg', { timeout: 5000 }).catch(() => {});
const lateText = await pl.locator('#chat').innerText();
check('a late arrival receives the chat backfill', lateText.includes(line),
  `${await pl.locator('#chat .msg').count()} messages backfilled`);
await late.close();

// --- Alice cannot press twice ----------------------------------------------

const pressCount = await pool.query(
  'SELECT count(*)::int AS n FROM presses WHERE user_id = (SELECT id FROM users WHERE name = $1) AND era_id = (SELECT id FROM eras WHERE ended_at IS NULL ORDER BY id DESC LIMIT 1)',
  [nameA],
);
check('exactly one press row for Alice', pressCount.rows[0].n === 1, `${pressCount.rows[0].n} rows`);

// --- Mobile layout ----------------------------------------------------------

const mob = await browser.newContext({
  viewport: { width: 390, height: 1500 },
  userAgent: `PW-Mobile-${Date.now().toString(36)}/1.0`,
  isMobile: true,
  hasTouch: true,
});
const pm = await mob.newPage();
await pm.goto(BASE);
await pm.waitForSelector('.gauge-seg');
const overflow = await pm.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
check('mobile layout does not scroll horizontally', overflow <= 0, `overflow ${overflow}px`);
await pm.screenshot({ path: `${OUT}/04-mobile.png`, fullPage: true });

// --- Graveyard --------------------------------------------------------------

await pa.goto(`${BASE}/graveyard`);
check('graveyard page renders dead eras',
  (await pa.locator('.card').count()) > 0, `${await pa.locator('.card').count()} eras`);
await pa.screenshot({ path: `${OUT}/05-graveyard.png`, fullPage: true });

// --- Flatline in the browser ------------------------------------------------

await pb.bringToFront();
await setSecondsLeft(-1);
await pb.waitForFunction(
  () => document.querySelector('#chat')?.textContent?.includes('flatlined'), null, { timeout: 12000 });
check('browser sees the flatline and the new era', true);
check('Bob gets his press back after flatline',
  !(await pb.locator('#press').isDisabled()));
await pb.screenshot({ path: `${OUT}/06-flatline.png`, fullPage: false });

await browser.close();
await pool.end();

const failed = results.filter((r) => !r.pass);
console.log(`\n${results.length - failed.length}/${results.length} passed`);
console.log(`screenshots in ${OUT}/`);
if (failed.length) console.log('failed: ' + failed.map((f) => f.name).join(', '));
process.exit(failed.length ? 1 : 0);
