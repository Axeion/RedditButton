/**
 * Chat filter. Run with: npx tsx tests/filter.test.ts
 *
 * The false-positive block is the important half. A filter that catches every
 * slur but also eats "I passed at 3 seconds, classic" is worse than no filter:
 * it punishes the people behaving, and they have no idea why.
 */
import { checkMessage } from '../server/filter.ts';

let failures = 0;

function blocks(msg: string, why = ''): void {
  const v = checkMessage(msg);
  const pass = !v.ok;
  if (!pass) failures++;
  console.log(
    `${pass ? 'PASS' : 'FAIL'}  blocks   ${JSON.stringify(msg).slice(0, 46).padEnd(48)}` +
      (pass ? `[${v.ok ? '' : v.rule}]` : 'LET THROUGH') + (why ? `  ${why}` : ''),
  );
}

function allows(msg: string, why = ''): void {
  const v = checkMessage(msg);
  const pass = v.ok;
  if (!pass) failures++;
  console.log(
    `${pass ? 'PASS' : 'FAIL'}  allows   ${JSON.stringify(msg).slice(0, 46).padEnd(48)}` +
      (pass ? '' : `BLOCKED as ${v.ok ? '' : v.rule}`) + (why ? `  ${why}` : ''),
  );
}

console.log('--- ordinary chat must get through ---');
allows('who is still loaded?');
allows('that was way too close');
allows('hold. hold. HOLD.', 'short caps are fine');
allows('I pressed too early, I hate myself');
allows('gold or nothing');
allows('damn that was close', 'not a profanity filter');
allows('shit, 2.4 seconds', 'not a profanity filter');
allows('nice');
allows('gg');
allows('89.99 lmao');

console.log('\n--- Scunthorpe problem: innocent words containing blocked substrings ---');
allows('greetings from Scunthorpe');
allows('that was a classic press');
allows('I need to pass this class');
allows('assassin creed reference');
allows('check the cockpit');
allows('running the analysis now');
allows('my therapist would love this');
allows('he spent it niggardly', 'archaic but unrelated word');

console.log('\n--- slurs, including obfuscated ---');
blocks('you are a nigger');
blocks('n1gg3r', 'leetspeak');
blocks('n i g g e r', 'spaced out');
blocks('n-i-g-g-e-r', 'hyphenated');
blocks('NIGGER', 'caps');
blocks('nïggér', 'diacritics');
blocks('f4gg0t');
blocks('f.a.g.g.o.t');
blocks('you retard');
blocks('kys', 'threat');
blocks('kill yourself', 'threat');

console.log('\n--- spam and noise ---');
blocks('check out https://spam.example.com', 'links off by default');
blocks('visit www.scam.xyz now');
blocks('free crypto at bit.ly', 'url shortener');
blocks('t.co/abc123', 'shortener with path');
blocks('join discord.gg/whatever');
blocks('AAAAAAAAAAAAAAAAAAAA', 'flood');
blocks('THIS IS ALL CAPS SHOUTING AT EVERYONE', 'shouting');
blocks('a'.repeat(60), 'single-token wall');
blocks('sdkjfhgksjdhfgkjsdhfg', 'keyboard mash, no vowels');

console.log('\n--- boundaries of the noise rules ---');
allows('OK GO GO GO', 'short enough to not count as shouting');
allows('press at 3.41s and rank #1', 'decimals are not domains');
allows('89.99 was my time', 'decimals are not domains');
allows('i.e. you lose', 'single letter after the dot');
allows('U.S. servers are slow');
allows('hahahaha that was close', 'repeats under the flood threshold');
allows('nooooo it died', 'stretched word is not a flood');

console.log(failures === 0 ? '\nall filter checks passed' : `\n${failures} FAILED`);
process.exit(failures ? 1 : 0);
