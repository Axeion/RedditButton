import { config } from './config.ts';
import { query } from './db.ts';
import { limiters, logAbuse } from './abuse.ts';
import { bandById } from '@shared/bands.ts';
import type { BandId } from '@shared/bands.ts';
import { MAX_CHAT_LENGTH, type ChatDTO } from '@shared/protocol.ts';
import type { User } from './identity.ts';

/**
 * Recent messages kept in memory so a joining client gets instant backfill
 * without a round trip to Postgres on every connection.
 */
const RING_SIZE = 100;
let ring: ChatDTO[] = [];

/** Last body per user, for cheap "stop repeating yourself" suppression. */
const lastBody = new Map<string, { body: string; at: number }>();
const DUPLICATE_WINDOW_MS = 30_000;

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
     WHERE m.era_id = $1
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

  if (!limiters.chatBurst.take(user.ipHash) || !limiters.chatRate.take(user.ipHash)) {
    logAbuse(user.ipHash, 'chat_rate');
    const wait = Math.ceil(limiters.chatBurst.retryAfterMs(user.ipHash) / 1000);
    return { ok: false, code: 'rate_limited', message: `Too fast. Wait ${wait || 1}s.` };
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

  return { ok: true, message: dto };
}

setInterval(() => {
  const cutoff = Date.now() - DUPLICATE_WINDOW_MS;
  for (const [k, v] of lastBody) if (v.at < cutoff) lastBody.delete(k);
}, 60_000).unref();

export const chatConfig = {
  maxLength: MAX_CHAT_LENGTH,
  intervalMs: config.limits.chatIntervalMs,
};
