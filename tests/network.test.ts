/**
 * Address -> network-key bucketing. Run with: npx tsx tests/network.test.ts
 *
 * The whole anti-abuse layer keys on this. IPv6 privacy extensions rotate the
 * host half of an address routinely, so bucketing by full address would give a
 * single device an endless supply of fresh identities. Bucketing by /64 is what
 * makes the per-era press dedupe and the identity cap mean anything on IPv6.
 */
import { networkKey } from '../server/abuse.ts';

let failures = 0;

function eq(input: string, expected: string, why = ''): void {
  const got = networkKey(input);
  const pass = got === expected;
  if (!pass) failures++;
  console.log(
    `${pass ? 'PASS' : 'FAIL'}  ${input.padEnd(34)} -> ${got}` +
      (pass ? (why ? `   (${why})` : '') : `   expected ${expected}`),
  );
}

function same(a: string, b: string, why: string): void {
  const pass = networkKey(a) === networkKey(b);
  if (!pass) failures++;
  console.log(`${pass ? 'PASS' : 'FAIL'}  same bucket: ${a} == ${b}   (${why})`);
}

function differ(a: string, b: string, why: string): void {
  const pass = networkKey(a) !== networkKey(b);
  if (!pass) failures++;
  console.log(`${pass ? 'PASS' : 'FAIL'}  different:   ${a} != ${b}   (${why})`);
}

// IPv4 is used whole.
eq('203.0.113.7', '203.0.113.7');
eq('  203.0.113.7  ', '203.0.113.7');
eq('::ffff:203.0.113.7', '203.0.113.7', 'IPv4-mapped unwrapped');

// IPv6 collapses to /64.
eq('2001:db8:1234:5678:9abc:def0:1234:5678', '2001:0db8:1234:5678::/64');
eq('2001:db8:1234:5678::1', '2001:0db8:1234:5678::/64');
eq('2001:DB8:1234:5678::1', '2001:0db8:1234:5678::/64', 'case-insensitive');
eq('fe80::1%eth0', 'fe80:0000:0000:0000::/64', 'zone index dropped');
eq('::1', '0000:0000:0000:0000::/64');

// The point of the whole exercise: privacy-extension rotation within one /64
// must not buy a new identity.
same(
  '2001:db8:aaaa:bbbb:1111:2222:3333:4444',
  '2001:db8:aaaa:bbbb:9999:8888:7777:6666',
  'RFC 4941 rotation inside one subscriber prefix',
);

// But genuinely different subscribers must stay apart.
differ('2001:db8:aaaa:bbbb::1', '2001:db8:aaaa:cccc::1', 'different /64');
differ('203.0.113.7', '203.0.113.8', 'different IPv4 hosts');

// Malformed input is hashed whole rather than collapsing unrelated clients
// into one bucket.
eq('not-an-address', 'not-an-address');
eq('2001:db8:1', '2001:db8:1');

console.log(failures === 0 ? '\nall network-key checks passed' : `\n${failures} FAILED`);
process.exit(failures ? 1 : 0);
