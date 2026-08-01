/**
 * Analytics behaviour in a real browser.
 *
 *   npm i --no-save playwright
 *   node tests/analytics.test.mjs
 *
 * Two things are being checked, and the second matters more than the first:
 * that the events carry useful payloads, and that a blocked or failed tracker
 * cannot break the game. Ad blockers stop Umami for a large slice of real
 * traffic — if that took the button with it, analytics would be a liability.
 */
import { existsSync, mkdirSync } from 'node:fs';
import pg from 'pg';

let chromium;
try {
  ({ chromium } = await import('playwright'));
} catch {
  console.error('This test needs Playwright:\n\n  npm i --no-save playwright\n');
  process.exit(1);
}

const BASE = process.env.TEST_BASE ?? 'http://localhost:3000';
const DB = process.env.DATABASE_URL ?? 'postgres://postgres@127.0.0.1:5433/deadman';
const pool = new pg.Pool({ connectionString: DB });
mkdirSync('test-results', { recursive: true });

const results = [];
function check(name, pass, detail = '') {
  results.push({ name, pass });
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function setSecondsLeft(seconds) {
  await pool.query(
    `UPDATE eras SET expires_at = now() + ($1 || ' milliseconds')::interval,
                     paused_at = NULL
     WHERE ended_at IS NULL`,
    [String(Math.round(seconds * 1000))],
  );
  await sleep(2400);
}

const exe = process.env.CHROMIUM_PATH ?? '/opt/pw-browsers/chromium';
const browser = await chromium.launch(existsSync(exe) ? { executablePath: exe } : {});

// --- The tracker is present in the page -------------------------------------

const ctx = await browser.newContext({ userAgent: `Analytics-${Date.now().toString(36)}/1.0` });
const page = await ctx.newPage();

// Umami's own script is never loaded here: the point is to observe what the app
// SENDS, not to depend on a third party being reachable from CI.
await page.route('**/script.js', (route) => route.abort());
await page.addInitScript(() => {
  window.__events = [];
  window.umami = { track: (name, data) => window.__events.push({ name, data }) };
});

await page.goto(BASE);
await page.waitForFunction(() => document.querySelector('#you')?.textContent?.includes('you are'));

const hasTag = await page.evaluate(() =>
  !!document.querySelector('script[data-website-id]'));
check('umami script tag is injected into the page', hasTag);

const deferred = await page.evaluate(() =>
  document.querySelector('script[data-website-id]')?.hasAttribute('defer'));
check('tracker is deferred so it never blocks the countdown', deferred === true);

// --- The press event, which is the whole point ------------------------------

await setSecondsLeft(7.5);
await page.waitForFunction(() => Number(document.querySelector('#time')?.textContent) < 10);
await page.locator('#press').click();
await page.waitForSelector('#modal:not([hidden])', { timeout: 5000 });

const events = await page.evaluate(() => window.__events);
const press = events.find((e) => e.name === 'press');
check('press fires an event', !!press, JSON.stringify(press?.data));

// Derive the expectation from the press that actually happened. Hardcoding a
// band would only be asserting how fast this machine can click.
const shown = Number.parseFloat(await page.locator('#modal .big-time').innerText());
const expectedBucket =
  shown < 1 ? '0-1s' : shown < 5 ? '1-5s' : shown < 10 ? '5-10s'
  : shown < 20 ? '10-20s' : shown < 40 ? '20-40s' : shown < 60 ? '40-60s' : '60s+';
const expectedBand =
  shown < 5 ? 'gold' : shown < 11 ? 'crimson' : shown < 21 ? 'scarlet' : 'other';

check('press event band matches the press that happened',
  press?.data?.band === expectedBand, `pressed at ${shown}s -> band=${press?.data?.band}`);
check('press time is bucketed, not raw seconds',
  press?.data?.time === expectedBucket && !String(press?.data?.time).includes('.'),
  `${shown}s -> ${press?.data?.time}`);
check('press event carries the rank', typeof press?.data?.rank === 'number',
  `rank=${press?.data?.rank}`);

// --- Share events -----------------------------------------------------------

await page.locator('#modal .modal-actions button').click();
await sleep(300);
const afterShare = await page.evaluate(() => window.__events);
check('copying the share link fires an event',
  afterShare.some((e) => e.name === 'share-copy'));

// --- Sound toggle -----------------------------------------------------------

await page.locator('#modal-x').click();
await page.locator('#mute').click();
await sleep(200);
const afterSound = await page.evaluate(() => window.__events);
const snd = afterSound.find((e) => e.name === 'sound-toggle');
check('sound toggle is tracked with its new state', snd?.data?.on === true,
  JSON.stringify(snd?.data));

// --- Volume sanity ----------------------------------------------------------

const all = await page.evaluate(() => window.__events);
check('only user-initiated events are sent (no per-tick spam)', all.length <= 6,
  `${all.length} events: ${all.map((e) => e.name).join(', ')}`);

await ctx.close();

// --- The part that actually matters: blocked tracker ------------------------

const blocked = await browser.newContext({ userAgent: `Analytics-Blocked-${Date.now().toString(36)}/1.0` });
const bp = await blocked.newPage();

// Simulate an ad blocker: the script never loads, so window.umami never exists.
await bp.route('**/script.js', (route) => route.abort());

const pageErrors = [];
bp.on('pageerror', (e) => pageErrors.push(String(e)));

await bp.goto(BASE);
await bp.waitForFunction(() => document.querySelector('#you')?.textContent?.includes('you are'));

const clockRuns = await bp.evaluate(async () => {
  const first = Number(document.querySelector('#time')?.textContent);
  await new Promise((r) => setTimeout(r, 900));
  const second = Number(document.querySelector('#time')?.textContent);
  return second < first;
});
check('countdown still runs with the tracker blocked', clockRuns);

await setSecondsLeft(40);
await bp.locator('#press').click();
await bp.waitForSelector('#modal:not([hidden])', { timeout: 5000 });
check('pressing still works with the tracker blocked',
  await bp.locator('#modal .big-time').isVisible());
check('no page errors when umami is absent', pageErrors.length === 0,
  pageErrors.join(' | ') || 'none');

await bp.screenshot({ path: 'test-results/12-analytics-blocked.png' });
await blocked.close();

await browser.close();
await pool.end();

const failed = results.filter((r) => !r.pass);
console.log(`\n${results.length - failed.length}/${results.length} passed`);
if (failed.length) console.log('failed: ' + failed.map((f) => f.name).join(', '));
process.exit(failed.length ? 1 : 0);
