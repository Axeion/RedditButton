/**
 * PUBLIC_ORIGIN normalisation. Run with: npx tsx tests/origin.test.ts
 *
 * This value is typed by hand into a hosting dashboard, and it has already been
 * wrong twice in two different ways: once without a scheme ("deadman.lol"),
 * once with the wrong case ("Https://Deadman.lol"). Both produce an og:image
 * that some scrapers refuse, which means share cards silently stop unfurling —
 * a failure nobody notices until they wonder why links look bare.
 */
import { normalizeOrigin } from '../server/config.ts';

let failures = 0;

function eq(input: string | undefined, expected: string): void {
  const got = normalizeOrigin(input);
  const pass = got === expected;
  if (!pass) failures++;
  console.log(
    `${pass ? 'PASS' : 'FAIL'}  ${JSON.stringify(input ?? null).padEnd(34)} -> ${got || '(empty)'}` +
      (pass ? '' : `   expected ${expected}`),
  );
}

// Missing scheme
eq('deadman.lol', 'https://deadman.lol');
eq('Deadman.lol', 'https://deadman.lol');

// Wrong case on the scheme or host — both legal per RFC 3986, both risky.
eq('Https://Deadman.lol', 'https://deadman.lol');
eq('HTTP://Deadman.LOL', 'http://deadman.lol');

// Trailing slashes, and a pasted path we should discard.
eq('https://deadman.lol/', 'https://deadman.lol');
eq('https://deadman.lol///', 'https://deadman.lol');
eq('https://deadman.lol/some/path', 'https://deadman.lol');

// Ports survive — needed for staging and local runs.
eq('http://localhost:3000', 'http://localhost:3000');

// Whitespace from a copy/paste
eq('  https://deadman.lol  ', 'https://deadman.lol');

// Unset means "infer from the request", not a broken origin.
eq(undefined, '');
eq('', '');
eq('   ', '');

console.log(failures === 0 ? '\nall origin checks passed' : `\n${failures} FAILED`);
process.exit(failures ? 1 : 0);
