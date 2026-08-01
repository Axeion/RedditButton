# Deadman

**It stays alive while someone still presses.**

A recreation of Reddit's 2015 [r/thebutton](https://en.wikipedia.org/wiki/The_Button_(Reddit))
social experiment. One giant button, one 90-second countdown shared by every
visitor on the site, and one press per person. Anyone who presses resets the
clock to 90. If nobody presses, it dies.

The twist that makes it competitive: **pressing late is pressing well.** Your
permanent flair colour is set by how little time was left when you pressed, and
the leaderboard ranks the lowest time first. Everyone is playing chicken with a
clock that thousands of strangers are also trying to save.

When the clock does reach zero the era flatlines, its leaderboard freezes into
the Graveyard, a new era opens, and everyone gets their press back.

---

## Flair bands

| Time left | Band | | Time left | Band |
|---|---|---|---|---|
| 90–81 | Ash | | 40–31 | Amber |
| 80–71 | Slate | | 30–21 | Ember |
| 70–61 | Steel | | 20–11 | Scarlet |
| 60–51 | Teal | | 10–6 | Crimson |
| 50–41 | Moss | | **under 5** | **Gold** |

Cold means you flinched early; hot means you held your nerve. The live countdown
is drawn in the colour you'd earn by pressing *right now*, so you watch your
reward tier climb while your nerve drains.

The table lives in `shared/bands.ts` and is imported by both the server and the
client, so they can't disagree about what a press was worth.

---

## Features

- **Shared authoritative clock** — the server broadcasts a deadline, never a
  countdown; clients interpolate locally against a measured clock offset.
- **The Gauge** — live census of how many players hold each flair colour.
- **Live pressure** — `N watching · M loaded`, where *loaded* means a connected
  player who still has an unspent press. Tells you whether anyone is left to
  save it.
- **Close calls** — presses under 10s trigger a screen flash, a klaxon, and a
  permanent entry in the feed. A heartbeat accelerates under 15 seconds.
- **Share cards** — every press gets a rendered PNG and an Open Graph page at
  `/p/:id`, so a link preview shows the actual time you held out for.
- **Graveyard** — every dead era with its duration, top three, and *The Last
  Hand*: the final presser before nobody came.
- **Live chat**, era-scoped, with names in flair colours.
- Sound is **off by default**, and the setting persists.

---

## Running it locally

Needs Node 22+ and a Postgres.

```bash
npm install
cp .env.example .env          # then fill in DATABASE_URL
npm run dev                   # server on :3000, Vite client on :5173
```

Open http://localhost:5173. The Vite dev server proxies `/api`, `/ws`, and
`/card` to the Express process, so there's one origin and no CORS.

Production-shaped run:

```bash
npm run build
NODE_ENV=production node --env-file=.env dist/server.js   # everything on :3000
```

### Tests

```bash
npm test                                  # typecheck + bands + protocol suite
npm i --no-save playwright                # only needed for the browser test
npm run test:browser                      # two real browsers -> test-results/
```

Playwright is deliberately not a devDependency — it pulls ~150MB of browsers
into every production build for a test that only runs by hand.

`test:protocol` drives real WebSocket clients through pressing, double-press
rejection, network dedupe, chat limits, flatline, and every anti-abuse control.
`test:browser` proves two independent visitors share one clock and that a press
in one updates the other with no reload. Both need the server running.

---

## Deploying to Railway

Railway rather than Vercel for one concrete reason: live chat and a shared
authoritative clock need a long-lived process holding WebSocket connections.
Vercel's serverless functions can't, so it would need a third-party realtime
provider plus a separate database. Railway runs this as one container with
Postgres attached.

1. Create a Railway project from this repo.
2. `+ New` → `Database` → `Add PostgreSQL`.
3. On your **app** service → `Variables`, set:

   | Variable | Value |
   |---|---|
   | `DATABASE_URL` | `${{Postgres.DATABASE_URL}}` — a reference, see below |
   | `COOKIE_SECRET` | `openssl rand -hex 32` |
   | `IP_SALT` | `openssl rand -hex 32` |
   | `ADMIN_TOKEN` | `openssl rand -hex 32` (optional; gates `/admin/*`) |
   | `NODE_ENV` | `production` |
   | `PUBLIC_ORIGIN` | `https://your-domain` (optional) |

   Adding the database creates `DATABASE_URL` on the *database* service, not on
   your app — the reference in the table is what bridges them. Match the service
   name if yours isn't called `Postgres`.

4. Deploy. `railway.json` handles the build, start command, and health check.

### If you get a 502 with healthy-looking logs

Check the **target port on the custom domain** first: Settings → Networking →
your domain → target port. Railway injects `PORT` (8080) and the app listens on
it, but a domain attached with a different target port (80 is an easy mistake)
returns `Application failed to respond` while the logs show the app up,
connected, and serving. Nothing in the application output looks wrong, because
nothing in the application *is* wrong.

The log line `listening on [::]:8080` tells you the port to point the domain at.

### Two things that will bite you if you change the build config

- **`NODE_ENV=production` makes `npm ci` skip devDependencies** — which is where
  `vite`, `esbuild`, and `typescript` live. The install phase then succeeds and
  the build dies on `vite: not found`. The repo's `.npmrc` sets `include=dev` to
  prevent that; don't delete it.
- **Nixpacks already runs its own `npm ci` install phase.** Putting another
  `npm ci` in `buildCommand` fails with `EBUSY: resource busy or locked,
  rmdir '/app/node_modules/.cache'`. `buildCommand` must be build-only.

The app refuses to boot in production without a real `COOKIE_SECRET` — a
random-per-boot secret would silently log every player out on each deploy.

### Verify `trust proxy` immediately after deploying

```bash
curl https://your-app.up.railway.app/healthz
```

Hit it from two different networks and confirm you get **two different**
`ipHashPrefix` values. Identical values mean the app is seeing Railway's proxy
address instead of the client's, and **every network-level control below is
silently doing nothing.**

---

## Anti-abuse

Cookie identity was a deliberate choice — players are meant to be ephemeral, not
registered. That makes the attack obvious: clear cookies, press again. Layered
defence, cheapest first:

1. **Network hashing.** `sha256(networkKey + user-agent + IP_SALT)`, stored per
   user. Never a raw address, so a database leak exposes nothing. IPv6 is
   bucketed by its **/64 prefix**, not the full address — privacy extensions
   (RFC 4941) rotate the host half routinely, and hashing the whole address
   would hand one device an endless supply of fresh identities. See
   `tests/network.test.ts`.
2. **One press per IP hash per era.** The control that actually stops farming — a
   fresh cookie doesn't help if the network already spent its press. Enforced by
   a unique index, so concurrent presses can't race past a check. Configurable
   via `PRESS_DEDUPE_MODE` (`hard` / `soft` / `off`), because carrier-grade NAT
   can cause legitimate collisions.
3. **Identity-minting cap.** 3 new identities per IP per hour, 10 per day. Past
   the cap you become a **spectator**: the site still loads and you see every
   press live, you just can't press or chat.
4. **Rate limits** on presses (5/min), chat (1 per 2s, burst 3, 20/min),
   WebSocket handshakes, concurrent connections, and all HTTP.
5. **Protocol hardening.** 4KB max frame, every message schema-validated, and the
   connection dropped after three violations.
6. **Audit + kill switch.** Every block is written to `abuse_events`;
   `banned_hashes` plus `/admin/ban` stops an attack in progress. Without the log
   you can't tell a quiet night from an attack.

**Known gap: dual-stack.** A visitor reachable over both IPv4 and IPv6 has two
network keys, so they can hold two identities and spend two presses per era.
There is no way to link a subscriber's v4 and v6 addresses from the server, so
this is inherent to network-based dedupe rather than something to patch. It
costs one extra press per person, not unlimited ones.

**Honest limit:** layers 1–5 make abuse expensive and slow, not impossible.
Someone determined, with residential proxies, still gets through. Only real
accounts close that, and those were deliberately out of scope. The biggest step
available without them is putting Cloudflare Turnstile in front of *identity
creation* — not presses, since gating the press itself would ruin the moment.

---

## Moderation

Sign in at `/mod`. Controls then appear inline on the main page — no separate
dashboard, because moderating is something you do while reading the room, not
in another tab.

**Automatic filter.** Rejects with a visible reason rather than shadow-dropping:
a false positive that silently censors a real person is the worst failure here,
and at least a rejection tells them to rephrase. It catches slurs and threats
through obfuscation (`n1gg3r`, `f a g`, `f.a.g.g.o.t`, diacritics, zalgo), plus
links, shouting, floods, and keyboard mashing.

It is **not** a profanity filter. "damn" and "shit" go straight through — a chat
where you can't swear while a shared clock hits three seconds isn't the chat
anyone wanted. Tune it per-deployment with `CHAT_BLOCKLIST` / `CHAT_ALLOWLIST`
without touching code.

The false-positive tests in `tests/filter.test.ts` matter more than the true
positives: "Scunthorpe", "classic", "assassin", "analysis" and "therapist" must
all survive, and there's a regression test for each.

**Mod powers**, all inline on each message:

| Control | Effect |
|---|---|
| `del` | Removes one message for everyone, live |
| `purge` | Removes everything that user said this era |
| `5m` / `1h` | Times the user out; they're told why |
| `slow off / 5s / 15s / 30s` | Global chat cooldown |
| `lock` | Freezes chat entirely |

Deletes are **soft** — the row survives with `deleted_by`, so the audit trail
still points at something real.

**Named accounts, not a shared password.** Every action is written to
`mod_actions` against the moderator who took it. A shared password makes that
table worthless the first time two mods disagree about a deletion. Passwords are
scrypt-hashed (Node core — no native bcrypt build to fail on a deploy host) and
must be 12+ characters. Sessions are 7-day cookies storing only a hash, so a
database leak doesn't hand over live sessions. Disabling a mod kills their
sessions immediately.

There is **no self-signup**. Accounts exist only if an admin creates one:

```bash
curl -X POST https://deadman.lol/admin/mods \
  -H "x-admin-token: $ADMIN_TOKEN" -H 'content-type: application/json' \
  -d '{"username":"you","password":"a-long-passphrase","role":"admin"}'
```

**The client being a mod means nothing.** Hidden UI is not a permission check —
every mod action is re-authorised server-side against the session cookie, and
`tests/moderation.test.mjs` asserts that a player sending `modDelete` directly
over the WebSocket gets `forbidden` and the message survives.

---

## Cloudflare Turnstile (optional)

Set `TURNSTILE_SITE_KEY` and `TURNSTILE_SECRET_KEY` to turn it on; it's inert
without both.

It gates **identity creation only, never the press.** Gating the press would
destroy the game — you're diving for gold with three seconds left and a widget
appears. Identity is minted once, before you've seen the button, so the check is
invisible. Returning players with a valid cookie are never challenged.

This is what closes the gap IP hashing cannot: an attacker rotating residential
proxies really does arrive from a different network each time, so no
address-based control can separate them from real people. The automation itself
is what's detectable.

**It fails open.** If Cloudflare is unreachable, or the keys are misconfigured,
new players are let in and the event is logged to `abuse_events`. Losing every
signup for the duration of someone else's outage is worse than a few farmed
presses — and a sustained failure shows up in the log rather than silently.

---

## How it's built

```
shared/     bands.ts, protocol.ts      — imported by both sides
server/     index.ts     Express routes, admin, static
            game.ts      era lifecycle, authoritative clock, presses
            hub.ts       WebSocket fan-out
            identity.ts / abuse.ts / names.ts
            chat.ts, card.ts, pages.ts, db.ts, schema.ts
client/     main.ts, clock.ts, sound.ts, styles.css
tests/      bands, protocol, browser
```

Node 22, TypeScript, Express 5, `ws`, Postgres. The client is plain TypeScript
against the DOM — it's one page with five live regions, and a framework earns
nothing here; the whole bundle is about 5KB gzipped. Audio is synthesised with
WebAudio oscillators, so there are no sound files to load or license.

**Three things worth knowing before changing this:**

- The server computes `secondsLeft` from the database clock, under a row lock, at
  the moment the press lands. The client never sends a time. If it did, every
  entry on the leaderboard would be `0.01s`.
- `expires_at` lives on the era row; memory is only a cache that resyncs from it
  every 2 seconds. A restart resumes the live clock instead of handing everyone a
  free 90 seconds.
- `bandFor()` scans the band table forward, from the highest floor down. Scanning
  the other way matches gold's floor of `0` on every press — a bug that leaves
  the button working perfectly while silently making every press gold.
  `tests/bands.test.ts` exists to stop that coming back.
