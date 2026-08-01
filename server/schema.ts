/**
 * Idempotent schema, applied on every boot. Lives in TS rather than a .sql file
 * so the esbuild bundle stays a single self-contained artifact with no runtime
 * file lookups relative to dist/.
 */
export const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS eras (
  id            serial PRIMARY KEY,
  started_at    timestamptz NOT NULL DEFAULT now(),
  -- The authoritative deadline. Living here rather than in process memory is
  -- what lets a restart resume the live clock instead of resetting it.
  expires_at    timestamptz NOT NULL,
  ended_at      timestamptz,
  ended_reason  text,
  last_press_id integer
);

CREATE TABLE IF NOT EXISTS users (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name       text NOT NULL UNIQUE,
  -- sha256(ip + '|' + user-agent + '|' + IP_SALT). Never a raw address.
  ip_hash    text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS presses (
  id           serial PRIMARY KEY,
  era_id       integer NOT NULL REFERENCES eras(id) ON DELETE CASCADE,
  user_id      uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  ip_hash      text NOT NULL,
  seconds_left numeric(5,2) NOT NULL,
  band         text NOT NULL,
  pressed_at   timestamptz NOT NULL DEFAULT now(),
  -- Makes a double press a database-level impossibility rather than a race to
  -- be careful about in application code.
  UNIQUE (era_id, user_id)
);

CREATE TABLE IF NOT EXISTS messages (
  id         bigserial PRIMARY KEY,
  era_id     integer NOT NULL REFERENCES eras(id) ON DELETE CASCADE,
  user_id    uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  body       text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS abuse_events (
  id         bigserial PRIMARY KEY,
  ip_hash    text NOT NULL,
  kind       text NOT NULL,
  detail     text,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS banned_hashes (
  ip_hash    text PRIMARY KEY,
  reason     text,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS presses_era_rank_idx ON presses (era_id, seconds_left);
CREATE INDEX IF NOT EXISTS presses_alltime_idx  ON presses (seconds_left);
CREATE INDEX IF NOT EXISTS presses_era_band_idx ON presses (era_id, band);
CREATE INDEX IF NOT EXISTS messages_era_idx     ON messages (era_id, id DESC);
CREATE INDEX IF NOT EXISTS users_ip_recent_idx  ON users (ip_hash, created_at DESC);
CREATE INDEX IF NOT EXISTS abuse_recent_idx     ON abuse_events (created_at DESC);
CREATE INDEX IF NOT EXISTS abuse_ip_idx         ON abuse_events (ip_hash, created_at DESC);
`;

/**
 * Network-level press dedupe is enforced by a real unique index, not by an
 * application check, so concurrent presses from the same network can't slip
 * through a check-then-insert race. The index is created or dropped at boot to
 * match PRESS_DEDUPE_MODE.
 */
export const DEDUPE_INDEX = 'presses_era_ip_uniq';
export const CREATE_DEDUPE_INDEX = `CREATE UNIQUE INDEX IF NOT EXISTS ${DEDUPE_INDEX} ON presses (era_id, ip_hash);`;
export const DROP_DEDUPE_INDEX = `DROP INDEX IF EXISTS ${DEDUPE_INDEX};`;
