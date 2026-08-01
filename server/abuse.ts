import crypto from 'node:crypto';
import type { IncomingMessage } from 'node:http';
import { config } from './config.ts';
import { query } from './db.ts';

/**
 * How many proxy hops sit in front of us. Railway terminates TLS at its edge,
 * so exactly one.
 */
const TRUSTED_HOPS = Number.parseInt(process.env.TRUSTED_PROXY_HOPS ?? '1', 10) || 1;

function normalizeIp(ip: string): string {
  const t = ip.trim();
  // ::ffff:1.2.3.4 is an IPv4 address wearing an IPv6 costume.
  const m = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(t);
  return (m?.[1] ?? t).toLowerCase();
}

/**
 * Resolve the real client address.
 *
 * We take the Nth entry from the RIGHT of X-Forwarded-For, not the left. The
 * leftmost entry is whatever the client claimed and is trivially forged; each
 * proxy appends the address it actually observed, so with one trusted hop the
 * rightmost entry is the address our own edge saw. A forged
 * `X-Forwarded-For: 1.2.3.4` becomes `1.2.3.4, <real client>` and we still read
 * the real one.
 *
 * Works for both Express requests and raw WebSocket upgrade requests, which
 * never pass through Express middleware.
 */
export function clientIp(req: IncomingMessage): string {
  const raw = req.headers['x-forwarded-for'];
  const header = Array.isArray(raw) ? raw.join(',') : raw;

  if (header) {
    const parts = header.split(',').map((p) => p.trim()).filter(Boolean);
    if (parts.length > 0) {
      const idx = Math.max(0, parts.length - TRUSTED_HOPS);
      const picked = parts[idx] ?? parts[parts.length - 1];
      if (picked) return normalizeIp(picked);
    }
  }

  return normalizeIp(req.socket?.remoteAddress ?? '0.0.0.0');
}

/**
 * Salted hash of IP + user-agent. Never store the raw address: a database leak
 * then exposes nothing, and there is no retention question to answer.
 *
 * Including the UA is deliberate — it splits households and offices by
 * device/browser so that network-level dedupe doesn't punish everyone sharing
 * a router.
 */
export function ipHash(req: IncomingMessage): string {
  const ip = clientIp(req);
  const ua = (req.headers['user-agent'] ?? '').slice(0, 512);
  return crypto
    .createHash('sha256')
    .update(`${ip}|${ua}|${config.ipSalt}`)
    .digest('hex');
}

/** Short prefix for logs — enough to correlate, useless for reversing. */
export function shortHash(h: string): string {
  return h.slice(0, 12);
}

// ---------------------------------------------------------------------------
// Token-bucket rate limiting
// ---------------------------------------------------------------------------

interface Bucket {
  tokens: number;
  last: number;
}

export class RateLimiter {
  private buckets = new Map<string, Bucket>();

  constructor(
    private readonly capacity: number,
    private readonly refillPerMs: number,
    readonly name: string,
  ) {}

  /** Returns true if allowed. Consumes a token when it does. */
  take(key: string, cost = 1): boolean {
    const now = Date.now();
    let b = this.buckets.get(key);
    if (!b) {
      b = { tokens: this.capacity, last: now };
      this.buckets.set(key, b);
    } else {
      const elapsed = now - b.last;
      b.tokens = Math.min(this.capacity, b.tokens + elapsed * this.refillPerMs);
      b.last = now;
    }
    if (b.tokens < cost) return false;
    b.tokens -= cost;
    return true;
  }

  /** Milliseconds until `cost` tokens are available. 0 when allowed now. */
  retryAfterMs(key: string, cost = 1): number {
    const b = this.buckets.get(key);
    if (!b) return 0;
    const deficit = cost - b.tokens;
    return deficit <= 0 ? 0 : Math.ceil(deficit / this.refillPerMs);
  }

  /** Drop buckets that have fully refilled — they carry no state worth keeping. */
  sweep(): void {
    const now = Date.now();
    for (const [k, b] of this.buckets) {
      const refilled = b.tokens + (now - b.last) * this.refillPerMs;
      if (refilled >= this.capacity) this.buckets.delete(k);
    }
  }

  get size(): number {
    return this.buckets.size;
  }
}

const perMin = (n: number) => n / 60_000;

export const limiters = {
  press: new RateLimiter(config.limits.pressPerMin, perMin(config.limits.pressPerMin), 'press'),
  // Burst of 3, then sustained one message per chatIntervalMs.
  chatBurst: new RateLimiter(config.limits.chatBurst, 1 / config.limits.chatIntervalMs, 'chat-burst'),
  chatRate: new RateLimiter(config.limits.chatPerMin, perMin(config.limits.chatPerMin), 'chat-rate'),
  wsHandshake: new RateLimiter(
    config.limits.wsHandshakesPerMin,
    perMin(config.limits.wsHandshakesPerMin),
    'ws-handshake',
  ),
  http: new RateLimiter(config.limits.httpPerMin, perMin(config.limits.httpPerMin), 'http'),
};

setInterval(() => {
  for (const l of Object.values(limiters)) l.sweep();
}, 60_000).unref();

// ---------------------------------------------------------------------------
// Concurrent connection tracking
// ---------------------------------------------------------------------------

const concurrent = new Map<string, number>();

export function acquireConnSlot(hash: string): boolean {
  const n = concurrent.get(hash) ?? 0;
  if (n >= config.limits.wsConcurrentPerIp) return false;
  concurrent.set(hash, n + 1);
  return true;
}

export function releaseConnSlot(hash: string): void {
  const n = (concurrent.get(hash) ?? 1) - 1;
  if (n <= 0) concurrent.delete(hash);
  else concurrent.set(hash, n);
}

// ---------------------------------------------------------------------------
// Bans + audit log
// ---------------------------------------------------------------------------

/**
 * Banned hashes cached in memory — this is checked on every connection and
 * every press, and the set is tiny.
 */
let bannedCache = new Set<string>();
let bansLoadedAt = 0;

export async function refreshBans(): Promise<void> {
  const { rows } = await query<{ ip_hash: string }>('SELECT ip_hash FROM banned_hashes');
  bannedCache = new Set(rows.map((r) => r.ip_hash));
  bansLoadedAt = Date.now();
}

export function isBanned(hash: string): boolean {
  return bannedCache.has(hash);
}

export async function banHash(hash: string, reason: string): Promise<void> {
  await query(
    `INSERT INTO banned_hashes (ip_hash, reason) VALUES ($1, $2)
     ON CONFLICT (ip_hash) DO UPDATE SET reason = EXCLUDED.reason`,
    [hash, reason],
  );
  bannedCache.add(hash);
}

export async function unbanHash(hash: string): Promise<void> {
  await query('DELETE FROM banned_hashes WHERE ip_hash = $1', [hash]);
  bannedCache.delete(hash);
}

export function bansAge(): number {
  return Date.now() - bansLoadedAt;
}

export type AbuseKind =
  | 'identity_cap_hour'
  | 'identity_cap_day'
  | 'press_rate'
  | 'press_dup_network'
  | 'press_dup_network_soft'
  | 'chat_rate'
  | 'chat_duplicate'
  | 'ws_rate'
  | 'ws_concurrent'
  | 'ws_oversize'
  | 'ws_malformed'
  | 'banned_attempt'
  | 'http_rate';

/**
 * Fire-and-forget: an audit write must never be able to fail a player action.
 * Without this table you cannot tell a quiet night from an attack in progress.
 */
export function logAbuse(hash: string, kind: AbuseKind, detail?: string): void {
  query('INSERT INTO abuse_events (ip_hash, kind, detail) VALUES ($1, $2, $3)', [
    hash,
    kind,
    detail ?? null,
  ]).catch((err) => console.error('[abuse] log failed', kind, err));
}
