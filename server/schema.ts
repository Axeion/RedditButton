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

-- Moderation ---------------------------------------------------------------

CREATE TABLE IF NOT EXISTS mods (
  id            serial PRIMARY KEY,
  username      text NOT NULL UNIQUE,
  -- scrypt, encoded as scrypt$N$r$p$salt$hash. No bcrypt dependency needed;
  -- Node ships scrypt in core.
  password_hash text NOT NULL,
  role          text NOT NULL DEFAULT 'mod',
  created_at    timestamptz NOT NULL DEFAULT now(),
  last_seen_at  timestamptz,
  disabled_at   timestamptz
);

CREATE TABLE IF NOT EXISTS mod_sessions (
  -- sha256 of the cookie token: a database leak must not hand over live
  -- sessions.
  token_hash text PRIMARY KEY,
  mod_id     integer NOT NULL REFERENCES mods(id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL
);

-- Why named accounts instead of one shared password: this table is worthless
-- if every action is attributed to "the mod password".
CREATE TABLE IF NOT EXISTS mod_actions (
  id           bigserial PRIMARY KEY,
  mod_id       integer REFERENCES mods(id) ON DELETE SET NULL,
  mod_name     text NOT NULL,
  action       text NOT NULL,
  target_user  uuid,
  target_name  text,
  target_msg   bigint,
  detail       text,
  created_at   timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS timeouts (
  user_id    uuid PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  until      timestamptz NOT NULL,
  reason     text,
  by_mod     text,
  created_at timestamptz NOT NULL DEFAULT now()
);

-- Small key/value bag for chat settings so slow mode and lockdown survive a
-- restart instead of quietly switching themselves off mid-raid.
CREATE TABLE IF NOT EXISTS settings (
  key        text PRIMARY KEY,
  value      text NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- When the site is empty the clock freezes here rather than churning through
-- eras nobody is watching. expires_at stays frozen at its pre-pause value, so
-- the remaining time is exactly (expires_at - paused_at) and survives restarts.
ALTER TABLE eras ADD COLUMN IF NOT EXISTS paused_at timestamptz;

ALTER TABLE messages ADD COLUMN IF NOT EXISTS deleted_at timestamptz;
ALTER TABLE messages ADD COLUMN IF NOT EXISTS deleted_by text;

CREATE INDEX IF NOT EXISTS mod_sessions_expiry_idx ON mod_sessions (expires_at);
CREATE INDEX IF NOT EXISTS mod_actions_recent_idx  ON mod_actions (created_at DESC);
CREATE INDEX IF NOT EXISTS timeouts_until_idx      ON timeouts (until);
CREATE INDEX IF NOT EXISTS messages_live_idx       ON messages (era_id, id DESC) WHERE deleted_at IS NULL;

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
