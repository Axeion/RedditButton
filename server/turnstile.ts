/**
 * Cloudflare Turnstile verification.
 *
 * Gates IDENTITY CREATION only — never the press. Putting a challenge in front
 * of the press would wreck the game: the whole point is diving for a gold flair
 * with three seconds left, and a widget appearing at that moment is the end of
 * it. Identity is minted once, before the player has ever seen the button, so a
 * check there is invisible.
 *
 * This is what closes the gap IP hashing cannot: an attacker rotating
 * residential proxies genuinely does arrive from different networks every time,
 * so no address-based control can tell them apart. What gives them away is the
 * automation itself.
 *
 * Inert until both keys are set, so the feature ships dark and turns on when
 * you add credentials.
 */

const VERIFY_URL = 'https://challenges.cloudflare.com/turnstile/v0/siteverify';

export function turnstileEnabled(): boolean {
  return Boolean(process.env.TURNSTILE_SECRET_KEY && process.env.TURNSTILE_SITE_KEY);
}

export function siteKey(): string {
  return process.env.TURNSTILE_SITE_KEY ?? '';
}

export type TurnstileResult =
  | { ok: true; skipped?: boolean }
  | { ok: false; reason: string; failOpen: boolean };

/**
 * Verify a token against Cloudflare.
 *
 * Fails OPEN when Cloudflare itself is unreachable. That is a deliberate
 * tradeoff: a Cloudflare incident would otherwise stop every new player from
 * joining, and losing all signups for the duration of someone else's outage is
 * a worse outcome than a few farmed presses. The event is logged either way, so
 * a sustained "outage" is visible rather than silent.
 */
export async function verifyTurnstile(
  token: string | undefined,
  remoteIp?: string,
): Promise<TurnstileResult> {
  if (!turnstileEnabled()) return { ok: true, skipped: true };

  if (!token) {
    return { ok: false, reason: 'missing_token', failOpen: false };
  }

  const body = new URLSearchParams({
    secret: process.env.TURNSTILE_SECRET_KEY ?? '',
    response: token,
  });
  if (remoteIp) body.set('remoteip', remoteIp);

  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 5000);

    const res = await fetch(VERIFY_URL, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body,
      signal: controller.signal,
    });
    clearTimeout(timer);

    if (!res.ok) {
      return { ok: false, reason: `siteverify_http_${res.status}`, failOpen: true };
    }

    const data = (await res.json()) as {
      success?: boolean;
      'error-codes'?: string[];
    };

    if (data.success) return { ok: true };

    const codes = data['error-codes'] ?? [];
    // These mean OUR configuration is broken, not that the visitor is a bot.
    // Blocking real people because a key was mistyped is the wrong failure.
    const ourFault = codes.some((c) =>
      ['invalid-input-secret', 'missing-input-secret', 'bad-request'].includes(c),
    );
    return { ok: false, reason: codes.join(',') || 'rejected', failOpen: ourFault };
  } catch (err) {
    return {
      ok: false,
      reason: `unreachable: ${err instanceof Error ? err.message : String(err)}`,
      failOpen: true,
    };
  }
}
