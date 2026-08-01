import { config } from './config.ts';
import { query } from './db.ts';
import { limiters, logAbuse } from './abuse.ts';
import { bandById } from '@shared/bands.ts';
import type { BandId } from '@shared/bands.ts';
import { MAX_CHAT_LENGTH, type ChatDTO } from '@shared/protocol.ts';
import type { User } from './identity.ts';
import { checkMessage } from './filter.ts';
import { chatSettings, timeoutRemaining, type Mod } from './moderation.ts';

/**
 * Recent messages kept in memory so a joining client gets instant backfill
 * without a round trip to Postgres on every connection.
 */
const RING_SIZE = 100;
let ring: ChatDTO[] = [];

/** Last body per user, for cheap "stop repeating yourself" suppression. */
const lastBody = new Map<string, { body: string; at: number }>();
const DUPLICATE_WINDOW_MS = 30_000;

/** Last successful post per user, for slow mode. */
const lastPostAt = new Map<string, number>();

export async function loadRecent(eraId: number): Promise<void> {
  const { rows } = await query<{
    id: string;
    name: string;
    body: string;
    band: string | null;
    created_at: Date;
  }>(
    `SELECT m.id, u.name, m.body, m.created_at,
            (SELECT p.band FROM presses p
              WHERE p.user_id = m.user_id AND p.era_id = m.era_id) AS band
     FROM messages m JOIN users u ON u.id = m.user_id
     WHERE m.era_id = $1 AND m.deleted_at IS NULL
     ORDER BY m.id DESC LIMIT $2`,
    [eraId, RING_SIZE],
  );
  ring = rows
    .reverse()
    .map((r) => ({
      id: Number(r.id),
      name: r.name,
      body: r.body,
      band: r.band ? bandById(r.band).id : null,
      createdAt: r.created_at.getTime(),
    }));
}

export function backfill(): ChatDTO[] {
  return ring;
}

/** Chat is era-scoped, so a new era starts with a clean room. */
export function clearRing(): void {
  ring = [];
  lastBody.clear();
}

export type ChatResult =
  | { ok: true; message: ChatDTO }
  | { ok: false; code: string; message: string };

function sanitize(raw: string): string {
  return (
    raw
      // Control chars, zero-width padding, and line/paragraph separators. These
      // fake long messages and smuggle newlines past the UI.
      .replace(/[\x00-\x1F\x7F\u200B-\u200F\u2028\u2029\uFEFF]/g, '')
      // Collapse whitespace runs so "hi<40 spaces>there" can't wall the chat.
      .replace(/\s{2,}/g, ' ')
      .trim()
      .slice(0, MAX_CHAT_LENGTH)
  );
}

export async function postMessage(
  user: User,
  eraId: number,
  band: BandId | null,
  raw: string,
): Promise<ChatResult> {
  const body = sanitize(raw);
  if (!body) return { ok: false, code: 'empty', message: 'Say something.' };

  const settings = chatSettings();
  if (settings.locked) {
    return { ok: false, code: 'locked', message: 'Chat is locked by a moderator.' };
  }

  const muted = await timeoutRemaining(user.id);
  if (muted > 0) {
    const mins = Math.ceil(muted / 60);
    return {
      ok: false,
      code: 'timed_out',
      message: `You're timed out for another ${mins} minute${mins === 1 ? '' : 's'}.`,
    };
  }

  if (!limiters.chatBurst.take(user.ipHash) || !limiters.chatRate.take(user.ipHash)) {
    logAbuse(user.ipHash, 'chat_rate');
    const wait = Math.ceil(limiters.chatBurst.retryAfterMs(user.ipHash) / 1000);
    return { ok: false, code: 'rate_limited', message: `Too fast. Wait ${wait || 1}s.` };
  }

  // Slow mode is a separate, mod-controlled cooldown on top of the standing
  // rate limit, so a raid can be throttled without permanently tightening
  // limits for everyone afterwards.
  if (settings.slowModeMs > 0) {
    const last = lastPostAt.get(user.id) ?? 0;
    const waitMs = settings.slowModeMs - (Date.now() - last);
    if (waitMs > 0) {
      return {
        ok: false,
        code: 'slow_mode',
        message: `Slow mode: wait ${Math.ceil(waitMs / 1000)}s.`,
      };
    }
  }

  // Content check runs after the cheap rejections and before anything is
  // written, so a blocked message never reaches the database or the room.
  const verdict = checkMessage(body);
  if (!verdict.ok) {
    logAbuse(user.ipHash, 'chat_filtered', verdict.rule);
    return { ok: false, code: `filtered_${verdict.rule}`, message: verdict.reason };
  }

  const prev = lastBody.get(user.id);
  if (prev && prev.body === body && Date.now() - prev.at < DUPLICATE_WINDOW_MS) {
    logAbuse(user.ipHash, 'chat_duplicate');
    return { ok: false, code: 'duplicate', message: 'You just said that.' };
  }
  lastBody.set(user.id, { body, at: Date.now() });

  const { rows } = await query<{ id: string; created_at: Date }>(
    'INSERT INTO messages (era_id, user_id, body) VALUES ($1, $2, $3) RETURNING id, created_at',
    [eraId, user.id, body],
  );
  const row = rows[0]!;

  const dto: ChatDTO = {
    id: Number(row.id),
    name: user.name,
    body,
    band,
    createdAt: row.created_at.getTime(),
  };

  ring.push(dto);
  if (ring.length > RING_SIZE) ring = ring.slice(-RING_SIZE);
  lastPostAt.set(user.id, Date.now());

  return { ok: true, message: dto };
}

// ---------------------------------------------------------------------------
// Moderation
// ---------------------------------------------------------------------------

/**
 * Soft-delete: the row stays so the audit trail still has something to point
 * at, but it leaves the ring, the backfill, and every connected client.
 */
export async function deleteMessage(messageId: number, byMod: string): Promise<ChatDTO | null> {
  const { rows } = await query<{ id: string; user_id: string; name: string }>(
    `UPDATE messages m SET deleted_at = now(), deleted_by = $2
     FROM users u
     WHERE m.id = $1 AND m.user_id = u.id AND m.deleted_at IS NULL
     RETURNING m.id, m.user_id, u.name`,
    [messageId, byMod],
  );
  const row = rows[0];
  if (!row) return null;

  const idx = ring.findIndex((m) => m.id === messageId);
  const removed = idx >= 0 ? ring[idx]! : null;
  if (idx >= 0) ring.splice(idx, 1);

  return removed ?? { id: messageId, name: row.name, body: '', band: null, createdAt: 0 };
}

/**
 * Everything one user said this era, in one action. A spammer posts faster
 * than a mod can click individual messages, so per-message deletion alone
 * loses that race.
 */
export async function purgeUser(
  userId: string,
  eraId: number,
  byMod: string,
): Promise<{ ids: number[]; name: string | null }> {
  const { rows } = await query<{ id: string }>(
    `UPDATE messages SET deleted_at = now(), deleted_by = $3
     WHERE user_id = $1 AND era_id = $2 AND deleted_at IS NULL
     RETURNING id`,
    [userId, eraId, byMod],
  );
  const ids = rows.map((r) => Number(r.id));
  const idSet = new Set(ids);
  ring = ring.filter((m) => !idSet.has(m.id));

  const { rows: u } = await query<{ name: string }>('SELECT name FROM users WHERE id = $1', [userId]);
  return { ids, name: u[0]?.name ?? null };
}

/** Resolve a display name to a user id, so mods can act on what they can see. */
export async function userIdByName(name: string): Promise<string | null> {
  const { rows } = await query<{ id: string }>('SELECT id FROM users WHERE name = $1', [name]);
  return rows[0]?.id ?? null;
}

/** The author of a message, for "timeout whoever said this". */
export async function messageAuthor(
  messageId: number,
): Promise<{ userId: string; name: string } | null> {
  const { rows } = await query<{ user_id: string; name: string }>(
    `SELECT m.user_id, u.name FROM messages m JOIN users u ON u.id = m.user_id WHERE m.id = $1`,
    [messageId],
  );
  const r = rows[0];
  return r ? { userId: r.user_id, name: r.name } : null;
}

setInterval(() => {
  const cutoff = Date.now() - DUPLICATE_WINDOW_MS;
  for (const [k, v] of lastBody) if (v.at < cutoff) lastBody.delete(k);
}, 60_000).unref();

export const chatConfig = {
  maxLength: MAX_CHAT_LENGTH,
  intervalMs: config.limits.chatIntervalMs,
};
