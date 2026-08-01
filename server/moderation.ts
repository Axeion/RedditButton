import crypto from 'node:crypto';
import { promisify } from 'node:util';
import type { IncomingMessage, ServerResponse } from 'node:http';
import * as cookieLib from 'cookie';
import { query } from './db.ts';
import { IS_PROD } from './config.ts';

const scrypt = promisify(crypto.scrypt) as (
  password: string,
  salt: Buffer,
  keylen: number,
  options: crypto.ScryptOptions,
) => Promise<Buffer>;

export const MOD_COOKIE = 'dm_mod';

export interface Mod {
  id: number;
  username: string;
  role: 'mod' | 'admin';
}

// ---------------------------------------------------------------------------
// Password hashing
// ---------------------------------------------------------------------------

// Node ships scrypt in core, so there's no native bcrypt build to go wrong on
// a deploy host. These parameters take ~100ms, which is the point.
const SCRYPT = { N: 16384, r: 8, p: 1 } as const;
const KEYLEN = 64;

export async function hashPassword(password: string): Promise<string> {
  const salt = crypto.randomBytes(16);
  const key = await scrypt(password, salt, KEYLEN, { ...SCRYPT });
  return `scrypt$${SCRYPT.N}$${SCRYPT.r}$${SCRYPT.p}$${salt.toString('base64')}$${key.toString('base64')}`;
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const parts = stored.split('$');
  if (parts.length !== 6 || parts[0] !== 'scrypt') return false;

  const N = Number(parts[1]);
  const r = Number(parts[2]);
  const p = Number(parts[3]);
  const salt = Buffer.from(parts[4] ?? '', 'base64');
  const expected = Buffer.from(parts[5] ?? '', 'base64');
  if (!Number.isFinite(N) || !Number.isFinite(r) || !Number.isFinite(p)) return false;

  const key = await scrypt(password, salt, expected.length, { N, r, p });
  return key.length === expected.length && crypto.timingSafeEqual(key, expected);
}

// ---------------------------------------------------------------------------
// Accounts
// ---------------------------------------------------------------------------

export async function createMod(
  username: string,
  password: string,
  role: 'mod' | 'admin' = 'mod',
): Promise<Mod> {
  if (username.length < 3 || username.length > 32) {
    throw new Error('Username must be 3-32 characters.');
  }
  if (password.length < 12) {
    // A mod account can delete anything in the room; a short password on it is
    // not a tradeoff worth offering.
    throw new Error('Password must be at least 12 characters.');
  }

  const hash = await hashPassword(password);
  const { rows } = await query<{ id: number; username: string; role: string }>(
    `INSERT INTO mods (username, password_hash, role) VALUES ($1, $2, $3)
     ON CONFLICT (username) DO UPDATE SET password_hash = EXCLUDED.password_hash,
                                          role = EXCLUDED.role,
                                          disabled_at = NULL
     RETURNING id, username, role`,
    [username.toLowerCase(), hash, role],
  );
  const r = rows[0]!;
  return { id: r.id, username: r.username, role: r.role as 'mod' | 'admin' };
}

export async function listMods(): Promise<
  Array<{ id: number; username: string; role: string; created_at: Date; last_seen_at: Date | null }>
> {
  const { rows } = await query(
    `SELECT id, username, role, created_at, last_seen_at FROM mods
     WHERE disabled_at IS NULL ORDER BY username`,
  );
  return rows as never;
}

/** Surfaced at boot so "sign-in fails" has an obvious first thing to check. */
export async function countMods(): Promise<number> {
  const { rows } = await query<{ n: string }>(
    'SELECT count(*) AS n FROM mods WHERE disabled_at IS NULL',
  );
  return Number(rows[0]?.n ?? 0);
}

export async function disableMod(username: string): Promise<void> {
  await query('UPDATE mods SET disabled_at = now() WHERE username = $1', [username.toLowerCase()]);
  await query(
    'DELETE FROM mod_sessions WHERE mod_id = (SELECT id FROM mods WHERE username = $1)',
    [username.toLowerCase()],
  );
}

// ---------------------------------------------------------------------------
// Sessions
// ---------------------------------------------------------------------------

const SESSION_DAYS = 7;

function hashToken(token: string): string {
  return crypto.createHash('sha256').update(token).digest('hex');
}

export async function login(
  username: string,
  password: string,
  res: ServerResponse,
): Promise<Mod | null> {
  const { rows } = await query<{
    id: number;
    username: string;
    role: string;
    password_hash: string;
  }>(
    `SELECT id, username, role, password_hash FROM mods
     WHERE username = $1 AND disabled_at IS NULL`,
    [username.toLowerCase()],
  );
  const row = rows[0];

  // Hash even when the user doesn't exist, so response timing doesn't reveal
  // which usernames are real.
  const stored = row?.password_hash ?? (await hashPassword('placeholder-for-timing'));
  const ok = await verifyPassword(password, stored);
  if (!row || !ok) return null;

  const token = crypto.randomBytes(32).toString('base64url');
  await query(
    `INSERT INTO mod_sessions (token_hash, mod_id, expires_at)
     VALUES ($1, $2, now() + ($3 || ' days')::interval)`,
    [hashToken(token), row.id, String(SESSION_DAYS)],
  );
  await query('UPDATE mods SET last_seen_at = now() WHERE id = $1', [row.id]);

  res.setHeader(
    'Set-Cookie',
    cookieLib.serialize(MOD_COOKIE, token, {
      httpOnly: true,
      sameSite: 'lax',
      secure: IS_PROD,
      path: '/',
      maxAge: 60 * 60 * 24 * SESSION_DAYS,
    }),
  );

  return { id: row.id, username: row.username, role: row.role as 'mod' | 'admin' };
}

export async function logout(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const token = readModToken(req);
  if (token) await query('DELETE FROM mod_sessions WHERE token_hash = $1', [hashToken(token)]);
  res.setHeader(
    'Set-Cookie',
    cookieLib.serialize(MOD_COOKIE, '', { httpOnly: true, path: '/', maxAge: 0 }),
  );
}

function readModToken(req: IncomingMessage): string | null {
  const header = req.headers.cookie;
  if (!header) return null;
  return cookieLib.parse(header)[MOD_COOKIE] ?? null;
}

/** Resolve the signed-in moderator, if any. Works for HTTP and WS upgrades. */
export async function modFromRequest(req: IncomingMessage): Promise<Mod | null> {
  const token = readModToken(req);
  if (!token) return null;

  const { rows } = await query<{ id: number; username: string; role: string }>(
    `SELECT m.id, m.username, m.role
     FROM mod_sessions s JOIN mods m ON m.id = s.mod_id
     WHERE s.token_hash = $1 AND s.expires_at > now() AND m.disabled_at IS NULL`,
    [hashToken(token)],
  );
  const row = rows[0];
  return row ? { id: row.id, username: row.username, role: row.role as 'mod' | 'admin' } : null;
}

export async function sweepSessions(): Promise<void> {
  await query('DELETE FROM mod_sessions WHERE expires_at < now()');
}

// ---------------------------------------------------------------------------
// Audit
// ---------------------------------------------------------------------------

export type ModAction =
  | 'delete_message'
  | 'purge_user'
  | 'timeout'
  | 'untimeout'
  | 'slowmode'
  | 'lockdown'
  | 'login';

export async function audit(
  mod: Mod,
  action: ModAction,
  opts: { targetUser?: string; targetName?: string; targetMsg?: number; detail?: string } = {},
): Promise<void> {
  await query(
    `INSERT INTO mod_actions (mod_id, mod_name, action, target_user, target_name, target_msg, detail)
     VALUES ($1, $2, $3, $4, $5, $6, $7)`,
    [
      mod.id,
      mod.username,
      action,
      opts.targetUser ?? null,
      opts.targetName ?? null,
      opts.targetMsg ?? null,
      opts.detail ?? null,
    ],
  ).catch((err) => console.error('[mod] audit write failed', action, err));
}

export async function recentActions(limit = 100): Promise<unknown[]> {
  const { rows } = await query(
    `SELECT mod_name, action, target_name, target_msg, detail, created_at
     FROM mod_actions ORDER BY created_at DESC LIMIT $1`,
    [limit],
  );
  return rows;
}

// ---------------------------------------------------------------------------
// Timeouts
// ---------------------------------------------------------------------------

export async function timeoutUser(
  mod: Mod,
  userId: string,
  minutes: number,
  reason?: string,
): Promise<void> {
  await query(
    `INSERT INTO timeouts (user_id, until, reason, by_mod)
     VALUES ($1, now() + ($2 || ' minutes')::interval, $3, $4)
     ON CONFLICT (user_id) DO UPDATE
       SET until = EXCLUDED.until, reason = EXCLUDED.reason, by_mod = EXCLUDED.by_mod`,
    [userId, String(minutes), reason ?? null, mod.username],
  );
}

export async function clearTimeout_(userId: string): Promise<void> {
  await query('DELETE FROM timeouts WHERE user_id = $1', [userId]);
}

/** Remaining timeout in seconds, or 0. */
export async function timeoutRemaining(userId: string): Promise<number> {
  const { rows } = await query<{ secs: string | null }>(
    `SELECT EXTRACT(EPOCH FROM (until - now())) AS secs
     FROM timeouts WHERE user_id = $1 AND until > now()`,
    [userId],
  );
  return Math.max(0, Math.ceil(Number(rows[0]?.secs ?? 0)));
}

// ---------------------------------------------------------------------------
// Chat settings (slow mode / lockdown)
// ---------------------------------------------------------------------------

export interface ChatSettings {
  slowModeMs: number;
  locked: boolean;
}

let cached: ChatSettings = { slowModeMs: 0, locked: false };

export async function loadSettings(): Promise<ChatSettings> {
  const { rows } = await query<{ key: string; value: string }>('SELECT key, value FROM settings');
  const map = new Map(rows.map((r) => [r.key, r.value]));
  cached = {
    slowModeMs: Number(map.get('slow_mode_ms') ?? 0) || 0,
    locked: map.get('chat_locked') === 'true',
  };
  return cached;
}

export function chatSettings(): ChatSettings {
  return cached;
}

async function putSetting(key: string, value: string): Promise<void> {
  await query(
    `INSERT INTO settings (key, value) VALUES ($1, $2)
     ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()`,
    [key, value],
  );
}

export async function setSlowMode(seconds: number): Promise<ChatSettings> {
  const ms = Math.max(0, Math.min(300, Math.floor(seconds))) * 1000;
  await putSetting('slow_mode_ms', String(ms));
  cached = { ...cached, slowModeMs: ms };
  return cached;
}

export async function setLocked(locked: boolean): Promise<ChatSettings> {
  await putSetting('chat_locked', locked ? 'true' : 'false');
  cached = { ...cached, locked };
  return cached;
}
