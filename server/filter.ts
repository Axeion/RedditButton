/**
 * Chat content filter.
 *
 * Rejects with a reason rather than shadow-dropping: a false positive that
 * silently censors a real person is the worst outcome here, and at least a
 * visible rejection tells them to rephrase.
 *
 * Everything in this file is pure — no database, no clock, no config beyond
 * env-driven word lists — so the whole thing is exercised by tests/filter.test.ts.
 */

import { blockedTerms, NEVER_BLOCK } from './wordlist.ts';

export type Verdict =
  | { ok: true }
  | { ok: false; reason: string; rule: FilterRule };

export type FilterRule =
  | 'slur'
  | 'threat'
  | 'shouting'
  | 'link'
  | 'flood'
  | 'wall'
  | 'gibberish';

// ---------------------------------------------------------------------------
// Normalisation
// ---------------------------------------------------------------------------

/** Homoglyph and leetspeak substitutions used to dodge naive filters. */
const LEET: Record<string, string> = {
  '4': 'a', '@': 'a', '^': 'a',
  '8': 'b',
  '(': 'c', '<': 'c', '{': 'c',
  '3': 'e', '&': 'e',
  '6': 'g', '9': 'g',
  '1': 'i', '!': 'i', '|': 'i', '¡': 'i',
  '0': 'o',
  '5': 's', '$': 's',
  '7': 't', '+': 't',
  '2': 'z',
};

/**
 * Collapse a message toward its "intent" so obfuscation stops working.
 *
 * Strips diacritics, folds leetspeak, removes separators used to break words
 * apart ("f-u-c-k", "n i g"), and squashes runs of a repeated letter.
 */
function normalize(input: string): string {
  let s = input
    .normalize('NFKD')
    // Combining marks: strips accents, and defuses zalgo in one step.
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase();

  s = s.replace(/[4@^8(<{3&691!|¡05$7+2]/g, (c) => LEET[c] ?? c);

  // Separators inserted between letters purely to break up a word.
  s = s.replace(/[\s._\-*'"`~/\\,]+/g, '');

  // "niiiiice" -> "niice": keep a doubled letter, drop the rest, so real
  // double letters ("pass") survive while padding does not.
  s = s.replace(/(.)\1{2,}/g, '$1$1');

  return s.replace(/[^a-z0-9]/g, '');
}

/** Same idea, but keeps word boundaries so we can match whole words. */
function normalizeWords(input: string): string {
  return input
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[4@^8(<{3&691!|¡05$7+2]/g, (c) => LEET[c] ?? c)
    .replace(/(.)\1{2,}/g, '$1$1')
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// ---------------------------------------------------------------------------
// Checks
// ---------------------------------------------------------------------------

/**
 * Any domain-shaped token, not a list of known TLDs — a hardcoded list is a
 * losing game, and URL shorteners (bit.ly, t.co) are the main spam vector
 * precisely because their TLDs are unusual.
 *
 * Requires 2+ letters after the dot, which is what keeps "3.41s", "89.99",
 * "i.e." and "hold. hold." out of it.
 */
const URL_RE = /(https?:\/\/|www\.|\b[a-z0-9][a-z0-9-]{0,62}\.[a-z]{2,24}(\/|\b))/i;

function allowLinks(): boolean {
  return (process.env.CHAT_ALLOW_LINKS ?? 'false').toLowerCase() === 'true';
}

/**
 * True if a blocked term appears in the message.
 *
 * Runs two passes. The word pass is boundary-anchored and safe. The squashed
 * pass catches separator-splitting but only for terms long enough that an
 * accidental collision is implausible — and both passes bail out if the raw
 * message contains a known-innocent word that normalises into a blocked term.
 */
function findBlocked(raw: string): string | null {
  const words = normalizeWords(raw);
  const squashed = normalize(raw);

  const innocent = NEVER_BLOCK.filter((w) => raw.toLowerCase().includes(w));

  for (const term of blockedTerms()) {
    const t = normalize(term);
    if (!t) continue;

    // Skip if the only reason this could match is a known-innocent word.
    if (innocent.some((w) => normalize(w).includes(t))) continue;

    const boundary = new RegExp(`\\b${escapeRe(normalizeWords(term))}\\b`);
    if (boundary.test(words)) return term;

    if (t.length >= 4 && squashed.includes(t)) return term;
  }
  return null;
}

const SHOUT_MIN_LENGTH = 12;
const SHOUT_RATIO = 0.7;

function isShouting(raw: string): boolean {
  const letters = raw.replace(/[^a-zA-Z]/g, '');
  if (letters.length < SHOUT_MIN_LENGTH) return false;
  const caps = letters.replace(/[^A-Z]/g, '').length;
  return caps / letters.length >= SHOUT_RATIO;
}

/** A single unbroken token long enough to blow out the chat column. */
function isWall(raw: string): boolean {
  return raw.split(/\s+/).some((w) => w.length > 40);
}

function isFlood(raw: string): boolean {
  // Same character 12+ times in a row, after separators are removed.
  return /(.)\1{11,}/.test(raw.replace(/\s+/g, ''));
}

/** Keyboard mashing: long, no vowels, no spaces. */
function isGibberish(raw: string): boolean {
  const t = raw.trim().toLowerCase();
  if (t.length < 16 || /\s/.test(t)) return false;
  if (!/^[a-z]+$/.test(t)) return false;
  return !/[aeiou]/.test(t);
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

export function checkMessage(raw: string): Verdict {
  const blocked = findBlocked(raw);
  if (blocked) {
    return {
      ok: false,
      rule: 'slur',
      reason: 'That word is not welcome here.',
    };
  }

  if (!allowLinks() && URL_RE.test(raw)) {
    return { ok: false, rule: 'link', reason: 'Links are not allowed in chat.' };
  }

  if (isFlood(raw)) {
    return { ok: false, rule: 'flood', reason: 'Stop mashing the keyboard.' };
  }

  if (isWall(raw)) {
    return { ok: false, rule: 'wall', reason: 'Break that up — it is one giant word.' };
  }

  if (isGibberish(raw)) {
    return { ok: false, rule: 'gibberish', reason: 'That is not a sentence.' };
  }

  if (isShouting(raw)) {
    return { ok: false, rule: 'shouting', reason: 'Stop shouting.' };
  }

  return { ok: true };
}

export const _internals = { normalize, normalizeWords, findBlocked, isShouting, isWall, isFlood, isGibberish };
