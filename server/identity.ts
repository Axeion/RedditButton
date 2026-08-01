import crypto from 'node:crypto';
import * as cookieLib from 'cookie';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { config, COOKIE_NAME, IS_PROD } from './config.ts';
import { query } from './db.ts';
import { generateName } from './names.ts';
import { ipHash, isBanned, logAbuse } from './abuse.ts';

export interface User {
  id: string;
  name: string;
  ipHash: string;
}

export type IdentityResult =
  | { ok: true; user: User; minted: boolean }
  | { ok: false; code: 'banned' | 'identity_cap'; message: string };

// ---------------------------------------------------------------------------
// Signed cookies
// ---------------------------------------------------------------------------

function sign(value: string): string {
  return crypto
    .createHmac('sha256', config.cookieSecret)
    .update(value)
    .digest('base64url');
}

function pack(userId: string): string {
  return `${userId}.${sign(userId)}`;
}

/** Returns the user id only when the signature verifies. */
function unpack(raw: string | undefined): string | null {
  if (!raw) return null;
  const dot = raw.lastIndexOf('.');
  if (dot <= 0) return null;

  const id = raw.slice(0, dot);
  const mac = raw.slice(dot + 1);
  const expected = sign(id);

  // Length check first: timingSafeEqual throws on a length mismatch.
  if (mac.length !== expected.length) return null;
  if (!crypto.timingSafeEqual(Buffer.from(mac), Buffer.from(expected))) return null;

  return /^[0-9a-f-]{36}$/i.test(id) ? id : null;
}

export function readCookieUserId(req: IncomingMessage): string | null {
  const header = req.headers.cookie;
  if (!header) return null;
  const jar = cookieLib.parse(header);
  return unpack(jar[COOKIE_NAME]);
}

function setIdentityCookie(res: ServerResponse, userId: string): void {
  const serialized = cookieLib.serialize(COOKIE_NAME, pack(userId), {
    httpOnly: true,
    sameSite: 'lax',
    secure: IS_PROD,
    path: '/',
    maxAge: 60 * 60 * 24 * 365,
  });
  const existing = res.getHeader('Set-Cookie');
  const list = Array.isArray(existing) ? existing : existing ? [String(existing)] : [];
  res.setHeader('Set-Cookie', [...list, serialized]);
}

// ---------------------------------------------------------------------------
// Minting
// ---------------------------------------------------------------------------

/**
 * Cookie identity means clearing cookies mints a new player. That is inherent
 * to cookie-based identity, not a bug we can patch — so we make it slow and
 * visible rather than free. Combined with per-era network dedupe on presses,
 * farming stops being worth the effort.
 */
async function withinMintCap(hash: string): Promise<{ ok: boolean; kind?: 'hour' | 'day' }> {
  const { rows } = await query<{ hour: string; day: string }>(
    `SELECT
       count(*) FILTER (WHERE created_at > now() - interval '1 hour') AS hour,
       count(*) FILTER (WHERE created_at > now() - interval '1 day')  AS day
     FROM users WHERE ip_hash = $1`,
    [hash],
  );
  const hour = Number(rows[0]?.hour ?? 0);
  const day = Number(rows[0]?.day ?? 0);

  if (hour >= config.identityPerIpHour) return { ok: false, kind: 'hour' };
  if (day >= config.identityPerIpDay) return { ok: false, kind: 'day' };
  return { ok: true };
}

async function mintUser(hash: string): Promise<User> {
  // Unique name collisions are ~13M-to-1; a handful of retries is plenty.
  for (let attempt = 0; attempt < 8; attempt++) {
    const name = generateName();
    try {
      const { rows } = await query<{ id: string; name: string }>(
        'INSERT INTO users (name, ip_hash) VALUES ($1, $2) RETURNING id, name',
        [name, hash],
      );
      const row = rows[0]!;
      return { id: row.id, name: row.name, ipHash: hash };
    } catch (err) {
      const code = (err as { code?: string }).code;
      if (code !== '23505') throw err; // not a unique violation — real failure
    }
  }
  // Fall back to a guaranteed-unique suffix rather than failing the visitor.
  const name = `${generateName()}_${crypto.randomBytes(2).toString('hex')}`;
  const { rows } = await query<{ id: string; name: string }>(
    'INSERT INTO users (name, ip_hash) VALUES ($1, $2) RETURNING id, name',
    [name, hash],
  );
  const row = rows[0]!;
  return { id: row.id, name: row.name, ipHash: hash };
}

/**
 * Resolve the visitor to a user, minting one if needed. Called on the HTML page
 * load so that by the time the WebSocket opens, the cookie already exists —
 * an upgrade request can read cookies but cannot set them.
 */
export async function ensureIdentity(
  req: IncomingMessage,
  res: ServerResponse,
): Promise<IdentityResult> {
  const hash = ipHash(req);

  if (isBanned(hash)) {
    logAbuse(hash, 'banned_attempt', 'page load');
    return { ok: false, code: 'banned', message: 'This network is banned.' };
  }

  const existingId = readCookieUserId(req);
  if (existingId) {
    const { rows } = await query<{ id: string; name: string; ip_hash: string }>(
      'SELECT id, name, ip_hash FROM users WHERE id = $1',
      [existingId],
    );
    const row = rows[0];
    if (row) {
      // Refresh the cookie so an active player's year-long expiry keeps rolling.
      setIdentityCookie(res, row.id);
      return { ok: true, user: { id: row.id, name: row.name, ipHash: row.ip_hash }, minted: false };
    }
    // Signed cookie for a user that no longer exists (wiped DB / new era of the
    // universe). Fall through and mint a fresh one.
  }

  const cap = await withinMintCap(hash);
  if (!cap.ok) {
    logAbuse(hash, cap.kind === 'hour' ? 'identity_cap_hour' : 'identity_cap_day');
    return {
      ok: false,
      code: 'identity_cap',
      message:
        'Too many new players from this network. You can still watch — ' +
        'try again later.',
    };
  }

  const user = await mintUser(hash);
  setIdentityCookie(res, user.id);
  return { ok: true, user, minted: true };
}

/** Read-only lookup for the WebSocket upgrade path. */
export async function identityFromRequest(req: IncomingMessage): Promise<User | null> {
  const id = readCookieUserId(req);
  if (!id) return null;
  const { rows } = await query<{ id: string; name: string; ip_hash: string }>(
    'SELECT id, name, ip_hash FROM users WHERE id = $1',
    [id],
  );
  const row = rows[0];
  return row ? { id: row.id, name: row.name, ipHash: row.ip_hash } : null;
}
