/**
 * Umami analytics injection.
 *
 * Configured by env rather than hardcoded, so the website ID stays out of the
 * repo and a staging deploy can point somewhere else (or nowhere). Injected
 * server-side rather than baked into the built HTML, so changing it is a
 * variable change and a restart, not a rebuild.
 *
 * Note this only injects in production. Dev traffic polluting the numbers is
 * worse than not measuring dev at all.
 */

function attr(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');
}

export function umamiEnabled(): boolean {
  return Boolean(process.env.UMAMI_WEBSITE_ID && process.env.UMAMI_SCRIPT_URL);
}

/**
 * The script tag, or empty string when unconfigured.
 *
 * `defer` matters: the tracker must never sit in front of the countdown
 * rendering. If Umami is slow or blocked, the game still starts on time.
 */
export function umamiTag(): string {
  if (!umamiEnabled()) return '';
  const src = process.env.UMAMI_SCRIPT_URL ?? '';
  const id = process.env.UMAMI_WEBSITE_ID ?? '';

  // Host-only tracking keeps localhost and preview deploys out of the numbers
  // unless explicitly allowed.
  const domains = process.env.UMAMI_DOMAINS
    ? ` data-domains="${attr(process.env.UMAMI_DOMAINS)}"`
    : '';

  return `<script defer src="${attr(src)}" data-website-id="${attr(id)}"${domains}></script>`;
}
