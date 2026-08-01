import crypto from 'node:crypto';

function required(name: string, fallback?: string): string {
  const v = process.env[name] ?? fallback;
  if (v === undefined || v === '') {
    throw new Error(`Missing required env var ${name}. See .env.example.`);
  }
  return v;
}

function int(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) ? n : fallback;
}

export const IS_PROD = process.env.NODE_ENV === 'production';

/**
 * In dev we generate ephemeral secrets so the thing just runs. In production a
 * random-per-boot COOKIE_SECRET would silently log every player out on each
 * deploy, so we refuse to start without a real one.
 */
function secret(name: string): string {
  const v = process.env[name];
  if (v && v !== '' && !v.startsWith('change-me')) return v;
  if (IS_PROD) {
    throw new Error(
      `${name} must be set in production. Generate one with: openssl rand -hex 32`,
    );
  }
  return crypto.randomBytes(32).toString('hex');
}

/**
 * Open Graph image URLs must be absolute, so a PUBLIC_ORIGIN of "deadman.lol"
 * (no scheme) would silently break every link preview. Normalise rather than
 * demand it be typed perfectly into a dashboard.
 */
export function normalizeOrigin(raw: string | undefined): string {
  const v = (raw ?? '').trim().replace(/\/+$/, '');
  if (!v) return '';

  const withScheme = /^https?:\/\//i.test(v) ? v : `https://${v}`;

  // Scheme and host are case-insensitive per RFC 3986, so "Https://Deadman.lol"
  // is technically valid — but link-preview scrapers are not all careful, and a
  // card that fails to unfurl is the whole feature not working. Parsing also
  // drops any path or query someone pasted in by mistake.
  try {
    const u = new URL(withScheme);
    return `${u.protocol}//${u.host}`.toLowerCase();
  } catch {
    return withScheme.toLowerCase();
  }
}

export type DedupeMode = 'hard' | 'soft' | 'off';

function dedupeMode(): DedupeMode {
  const v = (process.env.PRESS_DEDUPE_MODE ?? 'hard').toLowerCase();
  return v === 'soft' || v === 'off' ? v : 'hard';
}

export const config = {
  port: int('PORT', 3000),
  databaseUrl: required('DATABASE_URL', 'postgres://postgres@localhost:5433/deadman'),
  cookieSecret: secret('COOKIE_SECRET'),
  ipSalt: secret('IP_SALT'),
  adminToken: process.env.ADMIN_TOKEN ?? '',
  publicOrigin: normalizeOrigin(process.env.PUBLIC_ORIGIN),

  roundSeconds: int('ROUND_SECONDS', 90),

  /**
   * Seconds of zero viewers before the clock freezes. A grace period matters:
   * without one, a single reconnect would thrash pause/resume.
   */
  pauseAfterEmptySeconds: int('PAUSE_AFTER_EMPTY_SECONDS', 60),
  /** A paused era older than this is retired rather than resumed. */
  stalePauseHours: int('STALE_PAUSE_HOURS', 24),
  /** Set false to keep the original behaviour: it can die of neglect. */
  pauseWhenEmpty: (process.env.PAUSE_WHEN_EMPTY ?? 'true').toLowerCase() !== 'false',

  /** See .env.example — hard is the default and the one that stops farming. */
  dedupeMode: dedupeMode(),
  identityPerIpHour: int('IDENTITY_PER_IP_HOUR', 3),
  identityPerIpDay: int('IDENTITY_PER_IP_DAY', 10),

  limits: {
    pressPerMin: int('LIMIT_PRESS_PER_MIN', 5),
    chatBurst: int('LIMIT_CHAT_BURST', 3),
    chatPerMin: int('LIMIT_CHAT_PER_MIN', 20),
    chatIntervalMs: int('LIMIT_CHAT_INTERVAL_MS', 2000),
    wsHandshakesPerMin: int('LIMIT_WS_PER_MIN', 20),
    wsConcurrentPerIp: int('LIMIT_WS_CONCURRENT', 5),
    httpPerMin: int('LIMIT_HTTP_PER_MIN', 120),
  },
} as const;

export const COOKIE_NAME = 'dm_id';
