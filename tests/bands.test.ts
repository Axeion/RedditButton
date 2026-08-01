/**
 * Band boundary table. Run with: npx tsx tests/bands.test.ts
 *
 * These exist because the first version of bandFor scanned the table backwards
 * and matched gold's floor of 0 on every single press — a bug that is invisible
 * in casual play (the button still works) and ruins the entire scoring system.
 */
import { bandFor, BANDS, isCloseCall, ROUND_SECONDS } from '../shared/bands.ts';

let failures = 0;

function eq(secondsLeft: number, expected: string): void {
  const got = bandFor(secondsLeft).id;
  const pass = got === expected;
  if (!pass) failures++;
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${String(secondsLeft).padStart(6)}s -> ${got}${pass ? '' : ` (expected ${expected})`}`);
}

// Every boundary, from both sides.
eq(90, 'ash');
eq(81, 'ash');
eq(80.99, 'slate');
eq(71, 'slate');
eq(70.99, 'steel');
eq(61, 'steel');
eq(60.99, 'teal');
eq(51, 'teal');
eq(50.99, 'moss');
eq(41.7, 'moss');
eq(41, 'moss');
eq(40.99, 'amber');
eq(31, 'amber');
eq(30.99, 'ember');
eq(21, 'ember');
eq(20.99, 'scarlet');
eq(11, 'scarlet');
eq(10.99, 'crimson');
eq(5, 'crimson');
eq(4.99, 'gold');
eq(3.2, 'gold');
eq(0, 'gold');

// Out of range must clamp rather than fall off the table.
eq(-5, 'gold');
eq(1000, 'ash');

function assert(name: string, cond: boolean): void {
  if (!cond) failures++;
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}`);
}

assert('every band is reachable', new Set(
  Array.from({ length: ROUND_SECONDS * 10 + 1 }, (_, i) => bandFor(i / 10).id),
).size === BANDS.length);

assert('bands tile the range with no gaps', BANDS.every((b, i) => {
  const next = BANDS[i + 1];
  return next === undefined || next.max === b.min;
}));

assert('close call threshold is under 10s', isCloseCall(9.99) && !isCloseCall(10));
assert('gold is strictly below 5s', bandFor(4.999).id === 'gold' && bandFor(5).id !== 'gold');

console.log(failures === 0 ? '\nall band checks passed' : `\n${failures} FAILED`);
process.exit(failures ? 1 : 0);
