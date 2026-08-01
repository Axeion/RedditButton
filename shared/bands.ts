/**
 * Flair bands. Imported by BOTH server and client so they can never disagree
 * about what colour a press earned.
 *
 * Cold = you flinched early. Hot = you held your nerve.
 */

export const ROUND_SECONDS = 90;

export type BandId =
  | 'ash'
  | 'slate'
  | 'steel'
  | 'teal'
  | 'moss'
  | 'amber'
  | 'ember'
  | 'scarlet'
  | 'crimson'
  | 'gold';

export interface Band {
  id: BandId;
  label: string;
  /** Inclusive lower bound of seconds-remaining that earns this band. */
  min: number;
  /** Exclusive upper bound. */
  max: number;
  hex: string;
  /** Readable on white at small sizes. */
  textHex: string;
  blurb: string;
}

/** Ordered best-to-worst is the reverse of this list; this is 90 -> 0. */
export const BANDS: readonly Band[] = [
  { id: 'ash',     label: 'Ash',     min: 81, max: 90.001, hex: '#9AA0A6', textHex: '#6B7075', blurb: 'Flinched on sight.' },
  { id: 'slate',   label: 'Slate',   min: 71, max: 81,     hex: '#6B7A8F', textHex: '#54637A', blurb: 'Barely waited.' },
  { id: 'steel',   label: 'Steel',   min: 61, max: 71,     hex: '#4A6FA5', textHex: '#3D5C8A', blurb: 'Cautious.' },
  { id: 'teal',    label: 'Teal',    min: 51, max: 61,     hex: '#2E8B87', textHex: '#22706D', blurb: 'Steady.' },
  { id: 'moss',    label: 'Moss',    min: 41, max: 51,     hex: '#4C9A5A', textHex: '#3B7A46', blurb: 'Halfway brave.' },
  { id: 'amber',   label: 'Amber',   min: 31, max: 41,     hex: '#D4A32C', textHex: '#9A7515', blurb: 'Getting warm.' },
  { id: 'ember',   label: 'Ember',   min: 21, max: 31,     hex: '#E2792B', textHex: '#B45B15', blurb: 'Sweating.' },
  { id: 'scarlet', label: 'Scarlet', min: 11, max: 21,     hex: '#E03131', textHex: '#C21F1F', blurb: 'Nerve.' },
  { id: 'crimson', label: 'Crimson', min: 5,  max: 11,     hex: '#A61B29', textHex: '#8C1422', blurb: 'Ice in the veins.' },
  { id: 'gold',    label: 'Gold',    min: 0,  max: 5,      hex: '#F5B921', textHex: '#8A6100', blurb: 'Absolute madness.' },
] as const;

const BY_ID = new Map<BandId, Band>(BANDS.map((b) => [b.id, b]));

/** Server-computed seconds-remaining -> band. Clamps out-of-range input. */
export function bandFor(secondsLeft: number): Band {
  const s = Math.min(ROUND_SECONDS, Math.max(0, secondsLeft));
  // BANDS runs from the highest floor (ash, 81) to the lowest (gold, 0), so
  // scanning forward returns the first band whose floor we clear. Scanning the
  // other way would match gold's floor of 0 on every press.
  for (const b of BANDS) {
    if (s >= b.min) return b;
  }
  return BANDS[BANDS.length - 1]!;
}

export function bandById(id: string): Band {
  return BY_ID.get(id as BandId) ?? BANDS[0]!;
}

/** A press under this many seconds is a "close call": flash, klaxon, ticker. */
export const CLOSE_CALL_THRESHOLD = 10;

export function isCloseCall(secondsLeft: number): boolean {
  return secondsLeft < CLOSE_CALL_THRESHOLD;
}
