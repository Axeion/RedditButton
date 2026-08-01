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
npm test                # typecheck + band boundaries + full protocol suite
npm run test:browser    # two real browsers, screenshots into test-results/
```

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
2. Add the **Postgres** plugin — `DATABASE_URL` is injected automatically.
3. Set these variables:

   | Variable | Value |
   |---|---|
   | `COOKIE_SECRET` | `openssl rand -hex 32` |
   | `IP_SALT` | `openssl rand -hex 32` |
   | `ADMIN_TOKEN` | `openssl rand -hex 32` (optional; gates `/admin/*`) |
   | `NODE_ENV` | `production` |

4. Deploy. `railway.json` handles the build, start command, and health check.

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

1. **IP hashing.** `sha256(ip + user-agent + IP_SALT)`, stored per user. Never a
   raw address, so a database leak exposes nothing.
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

**Honest limit:** layers 1–5 make abuse expensive and slow, not impossible.
Someone determined, with residential proxies, still gets through. Only real
accounts close that, and those were deliberately out of scope. The biggest step
available without them is putting Cloudflare Turnstile in front of *identity
creation* — not presses, since gating the press itself would ruin the moment.

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
