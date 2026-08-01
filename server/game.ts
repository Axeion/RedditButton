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
  /**
   * The live deadline. While paused this is recomputed every tick as
   * (now + frozenRemainingMs), so clients always receive a meaningful deadline
   * and simply watch it stop moving. The database keeps expires_at frozen at
   * its pre-pause value, which is what makes the remaining time survive a
   * restart.
   */
  expiresAt: number;
  pausedAt: number | null;
  /** Milliseconds left on the clock when it froze. */
  frozenRemainingMs: number;
}

export const gameEvents = new EventEmitter();

let current: EraState | null = null;
let flatlining = false;

/** Live viewer count, reported by the hub. Drives pause and resume. */
let viewers = 0;
/** When the last viewer left; null while anyone is watching. */
let emptySince: number | null = Date.now();

export function reportViewers(n: number): void {
  viewers = n;
  if (n > 0) emptySince = null;
  else if (emptySince === null) emptySince = Date.now();
}

export function viewerCount(): number {
  return viewers;
}

export function currentEra(): EraState {
  if (!current) throw new Error('Game not initialised');
  return current;
}

export function isPaused(): boolean {
  return current?.pausedAt !== null && current !== null;
}

const roundMs = () => config.roundSeconds * 1000;
const graceMs = () => config.pauseAfterEmptySeconds * 1000;
const staleMs = () => config.stalePauseHours * 3600_000;

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

interface EraRow {
  id: number;
  started_at: Date;
  expires_at: Date;
  paused_at: Date | null;
}

const ERA_SELECT =
  'SELECT id, started_at, expires_at, paused_at FROM eras WHERE ended_at IS NULL ORDER BY id DESC LIMIT 1';

function toEraState(row: EraRow): EraState {
  const expiresAt = row.expires_at.getTime();
  if (row.paused_at) {
    const pausedAt = row.paused_at.getTime();
    // Clamped to a full round in both directions. Nothing in normal play can
    // exceed it, but expires_at edited directly while paused would otherwise
    // resume with more time than a round ever grants — an invariant worth
    // enforcing here rather than trusting every future caller to respect.
    const frozen = Math.min(roundMs(), Math.max(0, expiresAt - pausedAt));
    return {
      id: row.id,
      startedAt: row.started_at.getTime(),
      expiresAt: Date.now() + frozen,
      pausedAt,
      frozenRemainingMs: frozen,
    };
  }
  return {
    id: row.id,
    startedAt: row.started_at.getTime(),
    expiresAt,
    pausedAt: null,
    frozenRemainingMs: 0,
  };
}

// ---------------------------------------------------------------------------
// Era lifecycle
// ---------------------------------------------------------------------------

/**
 * Open a new era.
 *
 * Starts paused when nobody is watching, so an empty site does not immediately
 * begin burning through a fresh 90 seconds it will never be asked to defend.
 */
async function openEra(): Promise<EraState> {
  const startPaused = config.pauseWhenEmpty && viewers === 0;
  const { rows } = await query<EraRow>(
    `INSERT INTO eras (expires_at, paused_at)
     VALUES (now() + ($1 || ' milliseconds')::interval, ${startPaused ? 'now()' : 'NULL'})
     RETURNING id, started_at, expires_at, paused_at`,
    [String(roundMs())],
  );
  return toEraState(rows[0]!);
}

/**
 * Resume the live era from the database rather than starting a fresh clock.
 * Without this a redeploy would silently hand everyone a free 90 seconds — the
 * one bug that would quietly ruin the game.
 */
export async function initGame(): Promise<void> {
  const { rows } = await query<EraRow>(ERA_SELECT);
  const row = rows[0];

  if (!row) {
    current = await openEra();
    console.log(`[game] first era #${current.id} opened${current.pausedAt ? ' (paused, no viewers)' : ''}`);
  } else {
    current = toEraState(row);

    if (current.pausedAt !== null) {
      const pausedFor = Date.now() - current.pausedAt;
      if (pausedFor > staleMs()) {
        console.log(
          `[game] era #${current.id} paused ${(pausedFor / 3600_000).toFixed(1)}h — retiring as stale`,
        );
        await retireStale();
      } else {
        console.log(
          `[game] resumed era #${current.id} still paused, ` +
            `${(current.frozenRemainingMs / 1000).toFixed(2)}s frozen on the clock`,
        );
      }
    } else {
      const left = current.expiresAt - Date.now();
      if (left <= 0) {
        // It ran out while the process was down. Honour the death.
        console.log(`[game] era #${current.id} flatlined during downtime`);
        await flatline();
      } else {
        console.log(`[game] resumed era #${current.id}, ${(left / 1000).toFixed(2)}s left`);
      }
    }
  }

  // Fast tick against the in-memory deadline: flatline detection stays snappy
  // without hammering Postgres four times a second.
  setInterval(() => {
    if (!current) return;
    if (current.pausedAt !== null) {
      // Hold the deadline steady so connected clients see a stopped clock
      // rather than a number running past zero.
      current.expiresAt = Date.now() + current.frozenRemainingMs;
      return;
    }
    if (Date.now() >= current.expiresAt) void flatline();
  }, 250).unref();

  setInterval(() => void pauseTick(), 1000).unref();

  // Slow resync from the database, which is the actual source of truth. Memory
  // is a cache, and a cache that can never be corrected is just a second source
  // of truth waiting to disagree — after a manual edit, a failed transaction,
  // or a second replica.
  setInterval(() => void resyncFromDb(), 2000).unref();
}

/** Pull the live era back from the database if memory has drifted. */
async function resyncFromDb(): Promise<void> {
  if (!current || flatlining) return;
  try {
    const { rows } = await query<EraRow>(ERA_SELECT);
    const row = rows[0];
    if (!row) return;

    const fresh = toEraState(row);
    if (fresh.id !== current.id) {
      current = fresh;
      return;
    }
    // While paused the deadline is derived, so only the frozen remainder is
    // worth correcting; comparing derived deadlines would fight the tick.
    if (fresh.pausedAt !== null) {
      current.pausedAt = fresh.pausedAt;
      current.frozenRemainingMs = fresh.frozenRemainingMs;
      return;
    }
    current.pausedAt = null;
    if (Math.abs(fresh.expiresAt - current.expiresAt) > 250) {
      current.expiresAt = fresh.expiresAt;
    }
  } catch (err) {
    // A blip here is survivable: the fast tick keeps running off memory.
    console.error('[game] deadline resync failed', err);
  }
}

// ---------------------------------------------------------------------------
// Pause / resume
// ---------------------------------------------------------------------------

/**
 * Freeze and thaw the clock as the room empties and fills.
 *
 * Without this, an unwatched site burns an era every 90 seconds forever: ~960
 * era transitions a day, a Graveyard full of deaths nobody witnessed, and a
 * "longest era" statistic that measures nothing.
 *
 * The tradeoff is deliberate and worth stating: with pausing on, the button can
 * no longer die of pure neglect overnight, which is how the original ended. It
 * can still die whenever anyone is actually watching and nobody presses — which
 * is the only version of that death anyone is present to experience.
 * PAUSE_WHEN_EMPTY=false restores the original behaviour.
 */
async function pauseTick(): Promise<void> {
  if (!current || flatlining || !config.pauseWhenEmpty) return;

  try {
    if (viewers > 0) {
      if (current.pausedAt !== null) await resumeClock();
      return;
    }

    if (current.pausedAt !== null) {
      if (Date.now() - current.pausedAt > staleMs()) await retireStale();
      return;
    }

    // Grace period: a single reconnect shouldn't thrash pause/resume.
    if (emptySince !== null && Date.now() - emptySince >= graceMs()) {
      await pauseClock();
    }
  } catch (err) {
    console.error('[game] pause tick failed', err);
  }
}

async function pauseClock(): Promise<void> {
  if (!current) return;
  const { rows } = await query<EraRow>(
    `UPDATE eras SET paused_at = now()
     WHERE id = $1 AND ended_at IS NULL AND paused_at IS NULL
     RETURNING id, started_at, expires_at, paused_at`,
    [current.id],
  );
  const row = rows[0];
  if (!row) return;

  current = toEraState(row);
  console.log(
    `[game] era #${current.id} paused with ` +
      `${(current.frozenRemainingMs / 1000).toFixed(2)}s left — nobody watching`,
  );
  gameEvents.emit('pause', current);
}

async function resumeClock(): Promise<void> {
  if (!current || current.pausedAt === null) return;

  // Give back exactly what was on the clock: expires_at moves forward by the
  // duration of the pause.
  const { rows } = await query<EraRow>(
    `UPDATE eras
     SET expires_at = now() + LEAST(expires_at - paused_at, ($2 || ' milliseconds')::interval),
         paused_at = NULL
     WHERE id = $1 AND ended_at IS NULL AND paused_at IS NOT NULL
     RETURNING id, started_at, expires_at, paused_at`,
    [current.id, String(roundMs())],
  );
  const row = rows[0];
  if (!row) return;

  current = toEraState(row);
  console.log(
    `[game] era #${current.id} resumed with ` +
      `${((current.expiresAt - Date.now()) / 1000).toFixed(2)}s left`,
  );
  gameEvents.emit('resume', current);
}

/**
 * Retire an era that has been paused too long and open a fresh one.
 *
 * Marked 'stale' rather than 'flatline' and kept out of the Graveyard: it did
 * not die, nobody failed to save it, and burying it would be a lie. Any presses
 * it collected are untouched and still count on the all-time board.
 */
async function retireStale(): Promise<void> {
  if (!current) return;
  const staleId = current.id;

  const next = await tx(async (c) => {
    const { rows } = await c.query<{ id: number }>(
      'SELECT id FROM eras WHERE id = $1 AND ended_at IS NULL FOR UPDATE',
      [staleId],
    );
    if (!rows[0]) return null;

    await c.query(
      `UPDATE eras SET ended_at = paused_at, ended_reason = 'stale' WHERE id = $1`,
      [staleId],
    );
    const { rows: created } = await c.query<EraRow>(
      `INSERT INTO eras (expires_at, paused_at)
       VALUES (now() + ($1 || ' milliseconds')::interval, now())
       RETURNING id, started_at, expires_at, paused_at`,
      [String(roundMs())],
    );
    return created[0]!;
  });

  if (!next) return;
  current = toEraState(next);
  console.log(`[game] era #${staleId} retired as stale; era #${current.id} open and paused`);
  gameEvents.emit('stale', staleId, current);
}

/** End the current era, archive it, and open the next one. */
async function flatline(): Promise<void> {
  if (flatlining || !current) return;
  // A paused clock cannot run out. Belt and braces alongside the tick check.
  if (current.pausedAt !== null) return;

  flatlining = true;
  const deadId = current.id;

  try {
    const next = await tx(async (c) => {
      // Re-check under a row lock: a concurrent press may have saved it between
      // the tick firing and this transaction starting.
      const { rows } = await c.query<{ expires_at: Date; paused_at: Date | null }>(
        'SELECT expires_at, paused_at FROM eras WHERE id = $1 AND ended_at IS NULL FOR UPDATE',
        [deadId],
      );
      const row = rows[0];
      if (!row) return null;
      if (row.paused_at) return null; // paused between tick and transaction
      if (row.expires_at.getTime() > Date.now()) return null; // saved in time

      await c.query(
        `UPDATE eras SET ended_at = expires_at, ended_reason = 'flatline' WHERE id = $1`,
        [deadId],
      );
      const { rows: created } = await c.query<EraRow>(
        `INSERT INTO eras (expires_at) VALUES (now() + ($1 || ' milliseconds')::interval)
         RETURNING id, started_at, expires_at, paused_at`,
        [String(roundMs())],
      );
      return created[0]!;
    });

    if (!next) return; // saved at the last instant

    const summary = await eraSummary(deadId);
    current = toEraState(next);
    console.log(`[game] era #${deadId} flatlined; era #${current.id} open`);
    gameEvents.emit('flatline', summary, current);
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

/**
 * Only eras that actually flatlined are buried. A stale-retired era was never
 * defended and never lost — listing it as a death would be a lie, and it would
 * bury the real ones under noise.
 */
export async function graveyard(limit = 50): Promise<EraSummary[]> {
  const { rows } = await query<{ id: number }>(
    `SELECT id FROM eras
     WHERE ended_at IS NOT NULL AND ended_reason = 'flatline'
     ORDER BY ended_at DESC LIMIT $1`,
    [limit],
  );
  return Promise.all(rows.map((r) => eraSummary(r.id)));
}

/** Longest era ever survived, for the header stat. */
export async function longestEraMs(): Promise<number> {
  const { rows } = await query<{ ms: string | null }>(
    `SELECT max(EXTRACT(EPOCH FROM (ended_at - started_at)) * 1000) AS ms
     FROM eras WHERE ended_at IS NOT NULL AND ended_reason = 'flatline'`,
  );
  return Number(rows[0]?.ms ?? 0);
}

export async function pressById(id: number): Promise<PressDTO | null> {
  const { rows } = await query<PressRow>(`${PRESS_SELECT} WHERE p.id = $1`, [id]);
  if (!rows[0]) return null;
  const rank = await rankOf(rows[0].era_id, rows[0].seconds_left);
  return toPressDTO(rows[0], rank);
}
