/**
 * Analytics wrapper.
 *
 * Every call is a no-op when Umami isn't loaded — unconfigured, blocked by an
 * extension, or the script simply failed. Analytics must never be able to throw
 * inside a game loop, so nothing here is allowed to fail loudly.
 *
 * Why custom events at all: this is one page that never navigates, so the
 * default pageview tells you how many people arrived and nothing else. What
 * actually matters — did they press, how close did they cut it, did they share
 * it — only exists if we send it.
 */

interface Umami {
  track: (name: string, data?: Record<string, unknown>) => void;
}

function umami(): Umami | null {
  const u = (window as unknown as { umami?: Umami }).umami;
  return u && typeof u.track === 'function' ? u : null;
}

export function track(event: string, data?: Record<string, unknown>): void {
  try {
    umami()?.track(event, data);
  } catch {
    /* analytics is never worth breaking the page for */
  }
}

/**
 * Bucket a press time rather than sending the raw number.
 *
 * Raw seconds would give a near-unique value per press, which turns the Umami
 * breakdown into a list of thousands of one-off rows. Buckets are what you can
 * actually read: "how many people are cutting it under five seconds?"
 */
export function pressBucket(secondsLeft: number): string {
  if (secondsLeft < 1) return '0-1s';
  if (secondsLeft < 5) return '1-5s';
  if (secondsLeft < 10) return '5-10s';
  if (secondsLeft < 20) return '10-20s';
  if (secondsLeft < 40) return '20-40s';
  if (secondsLeft < 60) return '40-60s';
  return '60s+';
}
