/**
 * Chat moderation blocklist.
 *
 * Deliberately small and deliberately narrow: unambiguous slurs and hard
 * harassment terms only. It is NOT a profanity filter — "damn", "shit" and
 * friends are left alone, because a chat where people can't swear while a
 * shared clock runs out at 3 seconds isn't the chat anyone wanted, and every
 * term added here is another chance to censor an innocent message.
 *
 * Tune per-deployment without editing code:
 *   CHAT_BLOCKLIST=term1,term2   adds terms
 *   CHAT_ALLOWLIST=term1,term2   removes terms (fixing false positives fast)
 *
 * Matching is boundary-anchored against a normalised copy of the message, so
 * evasion like "n1gg3r" or "f a g" is caught while "Scunthorpe", "classic" and
 * "assassin" are not. See tests/filter.test.ts — the false-positive cases there
 * matter more than the true positives.
 */

/** Severe slurs. Always rejected. */
const SLURS: readonly string[] = [
  'nigger', 'nigga', 'niggers',
  'faggot', 'faggots', 'fag', 'fags',
  'retard', 'retards', 'retarded',
  'tranny', 'trannies',
  'kike', 'kikes',
  'spic', 'spics',
  'chink', 'chinks',
  'wetback', 'wetbacks',
  'gook', 'gooks',
  'coon', 'coons',
  'dyke', 'dykes',
  'raghead', 'ragheads',
  'paki', 'pakis',
];

/** Explicit threats and harassment patterns. Always rejected. */
const THREATS: readonly string[] = [
  'kill yourself',
  'kys',
  'kill your self',
  'neck yourself',
  'hang yourself',
  'go die',
];

function fromEnv(name: string): string[] {
  return (process.env[name] ?? '')
    .split(',')
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
}

/** Terms to block, after applying the env allow/block overrides. */
export function blockedTerms(): string[] {
  const allow = new Set(fromEnv('CHAT_ALLOWLIST'));
  return [...SLURS, ...THREATS, ...fromEnv('CHAT_BLOCKLIST')].filter((t) => !allow.has(t));
}

/**
 * Words that survive normalisation into something that looks like a blocked
 * term. Without these, aggressive de-obfuscation turns ordinary English into
 * false positives — the classic Scunthorpe problem.
 */
export const NEVER_BLOCK: readonly string[] = [
  'scunthorpe', 'penistone', 'lightwater', 'assassin', 'assassinate',
  'classic', 'class', 'pass', 'passage', 'bass', 'mass', 'massive',
  'cockpit', 'cocktail', 'peacock', 'shuttlecock',
  'analysis', 'analyse', 'analyze', 'canal',
  'grape', 'therapist', 'therapists',
  'niggardly', 'snigger', 'sniggering',
  'faggot-stitch',
];
