import pg from 'pg';
import { config, IS_PROD } from './config.ts';
import { SCHEMA_SQL, CREATE_DEDUPE_INDEX, DROP_DEDUPE_INDEX } from './schema.ts';

// numeric(5,2) arrives as a string by default because JS floats can't represent
// every numeric exactly. seconds_left is at most 90.00, so a float is lossless
// here and a number is far nicer downstream.
pg.types.setTypeParser(1700, (v) => Number.parseFloat(v));

/**
 * Whether to negotiate TLS to Postgres.
 *
 * Loopback and private service hostnames (Railway wires services together over
 * `*.railway.internal`) neither need nor necessarily support TLS; a public
 * Postgres host does, but its certificate typically doesn't chain to a public
 * root, so verification would reject a link that is fine. `DATABASE_SSL`
 * overrides the guess when the environment disagrees.
 */
function sslConfig(): pg.ConnectionConfig['ssl'] {
  const override = (process.env.DATABASE_SSL ?? 'auto').toLowerCase();
  if (override === 'off' || override === 'false' || override === 'disable') return undefined;
  if (override === 'require' || override === 'true') return { rejectUnauthorized: false };
  if (override === 'verify') return { rejectUnauthorized: true };

  let host = '';
  try {
    host = new URL(config.databaseUrl).hostname.toLowerCase();
  } catch {
    return undefined;
  }

  const isLocal =
    host === 'localhost' ||
    host === '::1' ||
    host === '[::1]' ||
    host === '' ||
    /^127\./.test(host) ||
    /^10\./.test(host) ||
    /^192\.168\./.test(host) ||
    /^172\.(1[6-9]|2\d|3[01])\./.test(host) ||
    host.endsWith('.internal') ||
    host.endsWith('.local');

  return IS_PROD && !isLocal ? { rejectUnauthorized: false } : undefined;
}

export const pool = new pg.Pool({
  connectionString: config.databaseUrl,
  max: 10,
  idleTimeoutMillis: 30_000,
  connectionTimeoutMillis: 10_000,
  ssl: sslConfig(),
});

pool.on('error', (err) => {
  console.error('[db] idle client error', err);
});

export async function query<T extends pg.QueryResultRow = pg.QueryResultRow>(
  text: string,
  params: unknown[] = [],
): Promise<pg.QueryResult<T>> {
  return pool.query<T>(text, params);
}

/** Run fn inside a transaction, rolling back on throw. */
export async function tx<T>(fn: (c: pg.PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const out = await fn(client);
    await client.query('COMMIT');
    return out;
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

/**
 * Wait for Postgres to accept a connection.
 *
 * Railway wires services together over an IPv6-only private network that takes
 * a moment to come up at container start, so the first connection attempt of a
 * fresh deploy can lose a race it would win a second later. Retrying turns a
 * hard boot failure into a short delay.
 */
export async function waitForDb(timeoutMs = 60_000): Promise<void> {
  const started = Date.now();
  let attempt = 0;

  for (;;) {
    try {
      await pool.query('SELECT 1');
      if (attempt > 0) {
        console.log(`[db] connected after ${attempt + 1} attempts (${Date.now() - started}ms)`);
      }
      return;
    } catch (err) {
      attempt++;
      if (Date.now() - started > timeoutMs) throw err;
      const delay = Math.min(5000, 250 * 2 ** Math.min(attempt, 5));
      console.warn(
        `[db] not ready (attempt ${attempt}): ${(err as Error).message} — retrying in ${delay}ms`,
      );
      await new Promise((r) => setTimeout(r, delay));
    }
  }
}

export async function migrate(): Promise<void> {
  await pool.query(SCHEMA_SQL);

  if (config.dedupeMode === 'hard') {
    try {
      await pool.query(CREATE_DEDUPE_INDEX);
    } catch (err) {
      // Existing duplicate rows (e.g. switching soft -> hard mid-era) block the
      // index. Don't crash the app over it; degrade loudly to app-level checks.
      console.error(
        '[db] could not create network-dedupe index — existing duplicate ' +
          '(era_id, ip_hash) rows. Falling back to application-level checks only.',
        err,
      );
    }
  } else {
    await pool.query(DROP_DEDUPE_INDEX);
  }

  console.log(`[db] schema ready (press dedupe: ${config.dedupeMode})`);
}
