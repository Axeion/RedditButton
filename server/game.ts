import { EventEmitter } from 'node:events';
import { config } from './config.ts';
import { query, tx } from './db.ts';
import { bandFor, bandById, isCloseCall, type BandId, BANDS } from '@shared/bands.ts';
import type { PressDTO, EraSummary, GaugeCounts } from '@shared/protocol.ts';
import { logAbuse, limiters } from './abuse.ts';
import type { User } from './identity.ts';

export interface EraState {
  id: number;
  startedAt: number;
  expiresAt: number;
}

export const gameEvents = new EventEmitter();

let current: EraState | null = null;
let flatlining = false;

export function currentEra(): EraState {
  if (!current) throw new Error('Game not initialised');
  return current;
}

const roundMs = () => config.roundSeconds * 1000;

// ---------------------------------------------------------------------------
// Row mapping
// ---------------------------------------------------------------------------

interface PressRow {
  id: number;
  era_id: number;
  name: string;
  seconds_left: number;
  band: string;
  pressed_at: Date;
}

function toPressDTO(r: PressRow, rank?: number): PressDTO {
  return {
    id: r.id,
    eraId: r.era_id,
    name: r.name,
    secondsLeft: Number(r.seconds_left),
    band: bandById(r.band).id,
    pressedAt: r.pressed_at.getTime(),
    ...(rank !== undefined ? { rank } : {}),
  };
}

const PRESS_SELECT = `
  SELECT p.id, p.era_id, u.name, p.seconds_left, p.band, p.pressed_at
  FROM presses p JOIN users u ON u.id = p.user_id`;

// ---------------------------------------------------------------------------
// Era lifecycle
// ---------------------------------------------------------------------------

async function openEra(): Promise<EraState> {
  const { rows } = await query<{ id: number; started_at: Date; expires_at: Date }>(
    `INSERT INTO eras (expires_at) VALUES (now() + ($1 || ' milliseconds')::interval)
     RETURNING id, started_at, expires_at`,
    [String(roundMs())],
  );
  const r = rows[0]!;
  return { id: r.id, startedAt: r.started_at.getTime(), expiresAt: r.expires_at.getTime() };
}

/**
 * Resume the live era from the database rather than starting a fresh clock.
 * Without this a redeploy would silently hand everyone a free 90 seconds — the
 * one bug that would quietly ruin the game.
 */
export async function initGame(): Promise<void> {
  const { rows } = await query<{ id: number; started_at: Date; expires_at: Date }>(
    'SELECT id, started_at, expires_at FROM eras WHERE ended_at IS NULL ORDER BY id DESC LIMIT 1',
  );
  const row = rows[0];

  if (!row) {
    current = await openEra();
    console.log(`[game] first era #${current.id} opened`);
  } else {
    current = {
      id: row.id,
      startedAt: row.started_at.getTime(),
      expiresAt: row.expires_at.getTime(),
    };
    const left = current.expiresAt - Date.now();
    if (left <= 0) {
      // It ran out while the process was down. Honour the death.
      console.log(`[game] era #${current.id} flatlined during downtime`);
      await flatline();
    } else {
      console.log(`[game] resumed era #${current.id}, ${(left / 1000).toFixed(2)}s left`);
    }
  }

  // Fast tick against the in-memory deadline: flatline detection stays snappy
  // without hammering Postgres four times a second.
  setInterval(() => {
    if (current && Date.now() >= current.expiresAt) void flatline();
  }, 250).unref();

  // Slow resync from the database, which is the actual source of truth. Memory
  // is a cache, and a cache that can never be corrected is just a second source
  // of truth waiting to disagree — after a manual edit, a failed transaction,
  // or a second replica.
  setInterval(() => void resyncFromDb(), 2000).unref();
}

/** Pull the live era's deadline back from the database if memory has drifted. */
async function resyncFromDb(): Promise<void> {
  if (!current || flatlining) return;
  try {
    const { rows } = await query<{ id: number; started_at: Date; expires_at: Date }>(
      'SELECT id, started_at, expires_at FROM eras WHERE ended_at IS NULL ORDER BY id DESC LIMIT 1',
    );
    const row = rows[0];
    if (!row) return;

    const expiresAt = row.expires_at.getTime();
    if (row.id !== current.id) {
      current = { id: row.id, startedAt: row.started_at.getTime(), expiresAt };
      return;
    }
    if (Math.abs(expiresAt - current.expiresAt) > 250) {
      current.expiresAt = expiresAt;
    }
  } catch (err) {
    // A blip here is survivable: the fast tick keeps running off memory.
    console.error('[game] deadline resync failed', err);
  }
}

/** End the current era, archive it, and open the next one. */
async function flatline(): Promise<void> {
  if (flatlining || !current) return;
  flatlining = true;
  const deadId = current.id;

  try {
    const next = await tx(async (c) => {
      // Re-check under a row lock: a concurrent press may have saved it between
      // the tick firing and this transaction starting.
      const { rows } = await c.query<{ expires_at: Date }>(
        'SELECT expires_at FROM eras WHERE id = $1 AND ended_at IS NULL FOR UPDATE',
        [deadId],
      );
      const row = rows[0];
      if (!row) return null;
      if (row.expires_at.getTime() > Date.now()) return null; // saved in time

      await c.query(
        `UPDATE eras SET ended_at = expires_at, ended_reason = 'flatline' WHERE id = $1`,
        [deadId],
      );
      const { rows: created } = await c.query<{ id: number; started_at: Date; expires_at: Date }>(
        `INSERT INTO eras (expires_at) VALUES (now() + ($1 || ' milliseconds')::interval)
         RETURNING id, started_at, expires_at`,
        [String(roundMs())],
      );
      const e = created[0]!;
      return { id: e.id, startedAt: e.started_at.getTime(), expiresAt: e.expires_at.getTime() };
    });

    if (!next) return; // saved at the last instant

    const summary = await eraSummary(deadId);
    current = next;
    console.log(`[game] era #${deadId} flatlined; era #${next.id} open`);
    gameEvents.emit('flatline', summary, next);
  } catch (err) {
    console.error('[game] flatline failed', err);
  } finally {
    flatlining = false;
  }
}

// ---------------------------------------------------------------------------
// Pressing
// ---------------------------------------------------------------------------

export type PressResult =
  | { ok: true; press: PressDTO; expiresAt: number; closeCall: boolean }
  | { ok: false; code: string; message: string };

/**
 * The whole game in one function.
 *
 * Note what is NOT here: any time value from the client. The remaining seconds
 * are computed by the database's own clock, under a row lock, at the moment the
 * press lands. A client cannot claim a gold flair it didn't earn.
 */
export async function press(user: User): Promise<PressResult> {
  if (!limiters.press.take(user.ipHash)) {
    logAbuse(user.ipHash, 'press_rate');
    return { ok: false, code: 'rate_limited', message: 'Slow down.' };
  }

  try {
    return await tx(async (c) => {
      const { rows } = await c.query<{ id: number; seconds_left: number }>(
        `SELECT id, EXTRACT(EPOCH FROM (expires_at - now())) AS seconds_left
         FROM eras WHERE ended_at IS NULL ORDER BY id DESC LIMIT 1 FOR UPDATE`,
      );
      const era = rows[0];
      if (!era) return { ok: false as const, code: 'no_era', message: 'No live era.' };

      const secondsLeft = Number(era.seconds_left);
      if (secondsLeft <= 0) {
        return { ok: false as const, code: 'flatlined', message: 'Too late. It already died.' };
      }

      // In soft mode we allow the press but record that the network had already
      // spent one, so the pattern is visible before deciding to tighten up.
      if (config.dedupeMode === 'soft') {
        const { rows: dup } = await c.query<{ n: string }>(
          'SELECT count(*) AS n FROM presses WHERE era_id = $1 AND ip_hash = $2',
          [era.id, user.ipHash],
        );
        if (Number(dup[0]?.n ?? 0) > 0) {
          logAbuse(user.ipHash, 'press_dup_network_soft', `era ${era.id}`);
        }
      }

      const band = bandFor(secondsLeft);
      const { rows: inserted } = await c.query<PressRow>(
        `INSERT INTO presses (era_id, user_id, ip_hash, seconds_left, band)
         VALUES ($1, $2, $3, $4, $5)
         RETURNING id, era_id, seconds_left, band, pressed_at`,
        [era.id, user.id, user.ipHash, secondsLeft.toFixed(2), band.id],
      );
      const row = inserted[0]!;

      const { rows: bumped } = await c.query<{ expires_at: Date }>(
        `UPDATE eras SET expires_at = now() + ($2 || ' milliseconds')::interval,
                         last_press_id = $3
         WHERE id = $1 RETURNING expires_at`,
        [era.id, String(roundMs()), row.id],
      );
      const expiresAt = bumped[0]!.expires_at.getTime();

      const dto = toPressDTO({ ...row, name: user.name });
      return { ok: true as const, press: dto, expiresAt, closeCall: isCloseCall(secondsLeft) };
    });
  } catch (err) {
    const e = err as { code?: string; constraint?: string };
    if (e.code === '23505') {
      if (e.constraint === 'presses_era_ip_uniq') {
        logAbuse(user.ipHash, 'press_dup_network');
        return {
          ok: false,
          code: 'network_pressed',
          message: 'Someone on this network already pressed this era.',
        };
      }
      return { ok: false, code: 'already_pressed', message: 'You only get one press.' };
    }
    console.error('[game] press failed', err);
    return { ok: false, code: 'error', message: 'Something broke. Try again.' };
  }
}

/** Applied after a successful press so the in-memory deadline matches the DB. */
export function applyExpiry(expiresAt: number): void {
  if (current) current.expiresAt = expiresAt;
}

// ---------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------

export async function myPress(eraId: number, userId: string): Promise<PressDTO | null> {
  const { rows } = await query<PressRow>(
    `${PRESS_SELECT} WHERE p.era_id = $1 AND p.user_id = $2`,
    [eraId, userId],
  );
  if (!rows[0]) return null;
  const rank = await rankOf(eraId, rows[0].seconds_left);
  return toPressDTO(rows[0], rank);
}

async function rankOf(eraId: number, secondsLeft: number): Promise<number> {
  const { rows } = await query<{ n: string }>(
    'SELECT count(*) AS n FROM presses WHERE era_id = $1 AND seconds_left < $2',
    [eraId, secondsLeft],
  );
  return Number(rows[0]?.n ?? 0) + 1;
}

/** Lowest seconds-remaining first: pressing late is pressing well. */
export async function eraLeaderboard(eraId: number, limit = 25): Promise<PressDTO[]> {
  const { rows } = await query<PressRow>(
    `${PRESS_SELECT} WHERE p.era_id = $1 ORDER BY p.seconds_left ASC, p.id ASC LIMIT $2`,
    [eraId, limit],
  );
  return rows.map((r, i) => toPressDTO(r, i + 1));
}

export async function allTimeLeaderboard(limit = 25): Promise<PressDTO[]> {
  const { rows } = await query<PressRow>(
    `${PRESS_SELECT} ORDER BY p.seconds_left ASC, p.id ASC LIMIT $1`,
    [limit],
  );
  return rows.map((r, i) => toPressDTO(r, i + 1));
}

export async function closeCalls(eraId: number, limit = 20): Promise<PressDTO[]> {
  const { rows } = await query<PressRow>(
    `${PRESS_SELECT} WHERE p.era_id = $1 AND p.seconds_left < 10
     ORDER BY p.id DESC LIMIT $2`,
    [eraId, limit],
  );
  return rows.map((r) => toPressDTO(r));
}

export async function gauge(eraId: number): Promise<GaugeCounts> {
  const { rows } = await query<{ band: string; n: string }>(
    'SELECT band, count(*) AS n FROM presses WHERE era_id = $1 GROUP BY band',
    [eraId],
  );
  const counts = Object.fromEntries(BANDS.map((b) => [b.id, 0])) as Record<BandId, number>;
  let total = 0;
  for (const r of rows) {
    const id = bandById(r.band).id;
    const n = Number(r.n);
    counts[id] = n;
    total += n;
  }
  return { counts, total };
}

export async function eraSummary(eraId: number): Promise<EraSummary> {
  const { rows } = await query<{
    id: number;
    started_at: Date;
    ended_at: Date | null;
    last_press_id: number | null;
    total: string;
  }>(
    `SELECT e.id, e.started_at, e.ended_at, e.last_press_id,
            (SELECT count(*) FROM presses p WHERE p.era_id = e.id) AS total
     FROM eras e WHERE e.id = $1`,
    [eraId],
  );
  const e = rows[0]!;
  const endedAt = e.ended_at ? e.ended_at.getTime() : null;

  const top = await eraLeaderboard(eraId, 3);

  let lastHand: PressDTO | null = null;
  if (e.last_press_id !== null) {
    const { rows: lh } = await query<PressRow>(`${PRESS_SELECT} WHERE p.id = $1`, [e.last_press_id]);
    if (lh[0]) lastHand = toPressDTO(lh[0]);
  }

  return {
    id: e.id,
    startedAt: e.started_at.getTime(),
    endedAt,
    durationMs: (endedAt ?? Date.now()) - e.started_at.getTime(),
    totalPresses: Number(e.total),
    top,
    lastHand,
  };
}

export async function graveyard(limit = 50): Promise<EraSummary[]> {
  const { rows } = await query<{ id: number }>(
    'SELECT id FROM eras WHERE ended_at IS NOT NULL ORDER BY ended_at DESC LIMIT $1',
    [limit],
  );
  return Promise.all(rows.map((r) => eraSummary(r.id)));
}

/** Longest era ever survived, for the header stat. */
export async function longestEraMs(): Promise<number> {
  const { rows } = await query<{ ms: string | null }>(
    `SELECT max(EXTRACT(EPOCH FROM (ended_at - started_at)) * 1000) AS ms
     FROM eras WHERE ended_at IS NOT NULL`,
  );
  return Number(rows[0]?.ms ?? 0);
}

export async function pressById(id: number): Promise<PressDTO | null> {
  const { rows } = await query<PressRow>(`${PRESS_SELECT} WHERE p.id = $1`, [id]);
  if (!rows[0]) return null;
  const rank = await rankOf(rows[0].era_id, rows[0].seconds_left);
  return toPressDTO(rows[0], rank);
}
