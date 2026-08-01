import { query } from './db.ts';

/**
 * Periodic pruning, so the database doesn't grow forever on a site whose whole
 * premise is churning through short-lived eras.
 *
 * The hard rule: **presses are never deleted.** They are the all-time
 * leaderboard, they are what a share card points at, and they are the only
 * permanent record anyone earned. Everything else here is either operational
 * exhaust or belongs to an era nobody can see any more.
 *
 * Retention is deliberately generous. Disk is cheap; deleting something a
 * moderator needed for an abuse investigation is not recoverable.
 */

export interface CleanupReport {
  emptyEras: number;
  staleEras: number;
  oldMessages: number;
  abuseEvents: number;
  timeouts: number;
  sessions: number;
  orphanUsers: number;
}

const DAYS = (n: number) => `${n} days`;

export async function runCleanup(): Promise<CleanupReport> {
  const report: CleanupReport = {
    emptyEras: 0,
    staleEras: 0,
    oldMessages: 0,
    abuseEvents: 0,
    timeouts: 0,
    sessions: 0,
    orphanUsers: 0,
  };

  // 1. Eras where literally nothing happened: nobody pressed, nobody spoke.
  //    These are the ~960/day an unwatched site used to generate before the
  //    clock learned to pause. Keeping the last hour so a live investigation
  //    still has recent context.
  const empty = await query(
    `DELETE FROM eras e
     WHERE e.ended_at IS NOT NULL
       AND e.ended_at < now() - interval '1 hour'
       AND NOT EXISTS (SELECT 1 FROM presses p WHERE p.era_id = e.id)
       AND NOT EXISTS (SELECT 1 FROM messages m WHERE m.era_id = e.id)`,
  );
  report.emptyEras = empty.rowCount ?? 0;

  // 2. Stale-retired eras that never saw a press. An era retired for being
  //    paused too long is not a story; one that collected presses is kept,
  //    because those presses still count on the all-time board.
  const stale = await query(
    `DELETE FROM eras e
     WHERE e.ended_reason = 'stale'
       AND e.ended_at < now() - interval '${DAYS(7)}'
       AND NOT EXISTS (SELECT 1 FROM presses p WHERE p.era_id = e.id)`,
  );
  report.staleEras = stale.rowCount ?? 0;

  // 3. Chat from long-dead eras. Chat is era-scoped and there is no UI anywhere
  //    that can show it once the era is buried, so past this point it is pure
  //    storage cost. Presses from those same eras stay.
  const messages = await query(
    `DELETE FROM messages m
     USING eras e
     WHERE m.era_id = e.id
       AND e.ended_at IS NOT NULL
       AND e.ended_at < now() - interval '${DAYS(30)}'`,
  );
  report.oldMessages = messages.rowCount ?? 0;

  // 4. Abuse audit. Long enough to investigate a pattern, not forever.
  const abuse = await query(
    `DELETE FROM abuse_events WHERE created_at < now() - interval '${DAYS(30)}'`,
  );
  report.abuseEvents = abuse.rowCount ?? 0;

  // 5. Expired timeouts. Kept a week past expiry so a mod can still see that
  //    someone was recently timed out before deciding what to do next.
  const timeouts = await query(
    `DELETE FROM timeouts WHERE until < now() - interval '${DAYS(7)}'`,
  );
  report.timeouts = timeouts.rowCount ?? 0;

  // 6. Dead sessions.
  const sessions = await query('DELETE FROM mod_sessions WHERE expires_at < now()');
  report.sessions = sessions.rowCount ?? 0;

  // 7. Identities that never did anything and are old enough that they never
  //    will. Deliberately last, and deliberately conservative: a user with any
  //    press is untouched, because deleting them would cascade that press out
  //    of the leaderboard.
  const orphans = await query(
    `DELETE FROM users u
     WHERE u.created_at < now() - interval '${DAYS(30)}'
       AND NOT EXISTS (SELECT 1 FROM presses p WHERE p.user_id = u.id)
       AND NOT EXISTS (SELECT 1 FROM messages m WHERE m.user_id = u.id)
       AND NOT EXISTS (SELECT 1 FROM timeouts t WHERE t.user_id = u.id)`,
  );
  report.orphanUsers = orphans.rowCount ?? 0;

  return report;
}

export function summarise(r: CleanupReport): string {
  const parts = Object.entries(r)
    .filter(([, n]) => n > 0)
    .map(([k, n]) => `${k}=${n}`);
  return parts.length ? parts.join(' ') : 'nothing to prune';
}

/**
 * Run daily, plus once shortly after boot to clear whatever accumulated while
 * the process was down.
 */
export function scheduleCleanup(): void {
  const run = async () => {
    try {
      const report = await runCleanup();
      console.log(`[cleanup] ${summarise(report)}`);
    } catch (err) {
      console.error('[cleanup] failed', err);
    }
  };

  setTimeout(() => void run(), 60_000).unref();
  setInterval(() => void run(), 24 * 3600_000).unref();
}
