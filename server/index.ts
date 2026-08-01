import express from 'express';
import http from 'node:http';
import path from 'node:path';
import { config, IS_PROD } from './config.ts';
import { migrate, waitForDb } from './db.ts';
import {
  ipHash, shortHash, limiters, logAbuse, isBanned, refreshBans, banHash, unbanHash,
  RateLimiter,
} from './abuse.ts';
import { ensureIdentity, readCookieUserId } from './identity.ts';
import * as game from './game.ts';
import * as chat from './chat.ts';
import { attachHub, connectionCount } from './hub.ts';
import { renderCard } from './card.ts';
import { sharePage, graveyardPage, modLoginPage } from './pages.ts';
import * as mods from './moderation.ts';
import { verifyTurnstile, turnstileEnabled, siteKey } from './turnstile.ts';
import { clientIp } from './abuse.ts';
import { query } from './db.ts';

const app = express();

/**
 * Railway terminates TLS at its edge, so without this every visitor would
 * resolve to the proxy's address: identical ip_hash for everyone, and every
 * network-level control silently dead. See /healthz to verify in production.
 */
app.set('trust proxy', 1);
app.disable('x-powered-by');
app.use(express.json({ limit: '16kb' }));
app.use(express.urlencoded({ extended: false, limit: '16kb' }));

/** Flipped once the database is migrated and the game is live. */
let ready = false;
let bootError: string | null = null;
export function setReady(): void {
  ready = true;
  bootError = null;
}

app.get('/healthz', async (req, res) => {
  // Answered even before the game is up, so a stuck boot is diagnosable from
  // the outside instead of showing as a bare 502.
  if (!ready) {
    res.status(503).json({
      ok: false,
      status: 'starting',
      detail: bootError ?? 'waiting for database',
    });
    return;
  }
  try {
    await query('SELECT 1');
    res.json({
      ok: true,
      era: game.currentEra().id,
      watching: connectionCount(),
      // Two different networks must show two different values here. Identical
      // values mean `trust proxy` is wrong and the anti-abuse layer is inert.
      ipHashPrefix: shortHash(ipHash(req)),
    });
  } catch (err) {
    res.status(503).json({ ok: false, status: 'database unreachable', detail: String(err) });
  }
});

// Global HTTP rate limit. /healthz is exempt so Railway's prober can't trip it.
app.use((req, res, next) => {
  const hash = ipHash(req);
  if (isBanned(hash)) {
    logAbuse(hash, 'banned_attempt', req.path);
    res.status(403).json({ error: 'banned' });
    return;
  }
  if (!limiters.http.take(hash)) {
    logAbuse(hash, 'http_rate', req.path);
    res.status(429).json({ error: 'rate_limited' });
    return;
  }
  next();
});

// Anything that touches the game or the database is unavailable until boot
// finishes. Static assets still serve, so the page loads and its WebSocket
// reconnect loop picks things up the moment the game is live.
app.use((req, res, next) => {
  if (ready) return next();
  if (/^\/(api|card|p|graveyard|admin|mod)\b/.test(req.path)) {
    res.status(503).json({ error: 'starting', message: 'Warming up. Try again in a moment.' });
    return;
  }
  next();
});

/**
 * Identity is minted here rather than on the HTML response, because a
 * WebSocket upgrade can read cookies but cannot set them — the cookie must
 * already exist by the time the socket opens. Works identically behind the
 * Vite dev proxy and in production.
 */
app.get('/api/identity', async (req, res) => {
  // Turnstile only matters when we're about to MINT. A returning player with a
  // valid cookie must never be challenged — they already proved themselves, and
  // re-challenging on every page load would be pure friction.
  if (turnstileEnabled() && !readCookieUserId(req)) {
    const token = (req.query.turnstile as string | undefined) ?? undefined;
    const verdict = await verifyTurnstile(token, clientIp(req));
    if (!verdict.ok) {
      if (verdict.failOpen) {
        // Cloudflare is down or misconfigured on our side. Log loudly and let
        // the visitor in rather than closing signups during someone else's
        // outage.
        logAbuse(ipHash(req), 'turnstile_failopen', verdict.reason);
        console.warn('[turnstile] failing open:', verdict.reason);
      } else {
        logAbuse(ipHash(req), 'turnstile_rejected', verdict.reason);
        res.status(403).json({
          error: 'turnstile',
          message: 'Could not verify you are human. Reload and try again.',
          siteKey: siteKey(),
        });
        return;
      }
    }
  }

  const result = await ensureIdentity(req, res);
  if (!result.ok) {
    res.status(result.code === 'banned' ? 403 : 429).json({ error: result.code, message: result.message });
    return;
  }
  res.json({ id: result.user.id, name: result.user.name, minted: result.minted });
});

/** Lets the client know whether it needs to render a Turnstile widget at all. */
app.get('/api/config', (_req, res) => {
  res.json({ turnstile: turnstileEnabled() ? siteKey() : null });
});

app.get('/api/graveyard', async (_req, res) => {
  const [eras, longest] = await Promise.all([game.graveyard(), game.longestEraMs()]);
  res.json({ eras, longestMs: longest });
});

app.get('/api/press/:id', async (req, res) => {
  const id = Number.parseInt(req.params.id ?? '', 10);
  if (!Number.isFinite(id)) {
    res.status(400).json({ error: 'bad id' });
    return;
  }
  const press = await game.pressById(id);
  if (!press) {
    res.status(404).json({ error: 'not found' });
    return;
  }
  res.json(press);
});

// --- Share cards ------------------------------------------------------------

app.get('/card/:id.png', async (req, res) => {
  const id = Number.parseInt(req.params.id ?? '', 10);
  if (!Number.isFinite(id)) {
    res.status(400).end();
    return;
  }
  const press = await game.pressById(id);
  if (!press) {
    res.status(404).end();
    return;
  }
  const png = await renderCard(press);
  res.setHeader('Content-Type', 'image/png');
  res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
  res.end(png);
});

function originOf(req: express.Request): string {
  return config.publicOrigin || `${req.protocol}://${req.get('host')}`;
}

app.get('/p/:id', async (req, res) => {
  const id = Number.parseInt(req.params.id ?? '', 10);
  const press = Number.isFinite(id) ? await game.pressById(id) : null;
  if (!press) {
    res.redirect('/');
    return;
  }
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.send(sharePage(press, originOf(req)));
});

app.get('/graveyard', async (req, res) => {
  const [eras, longest] = await Promise.all([game.graveyard(), game.longestEraMs()]);
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.send(graveyardPage(eras, longest, originOf(req)));
});

// --- Moderator sign-in ------------------------------------------------------

// A mod account can delete anything in the room, so the login endpoint gets a
// much tighter budget than ordinary traffic: 10 attempts per 15 minutes.
const loginLimiter = new RateLimiter(10, 10 / 900_000, 'mod-login');

app.get('/mod', async (req, res) => {
  const mod = await mods.modFromRequest(req);
  if (mod) {
    res.redirect('/');
    return;
  }
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.send(modLoginPage());
});

app.post('/mod/login', async (req, res) => {
  const hash = ipHash(req);
  if (!loginLimiter.take(hash)) {
    logAbuse(hash, 'mod_login_rate');
    res.status(429).setHeader('Content-Type', 'text/html; charset=utf-8');
    res.send(modLoginPage('Too many attempts. Wait a few minutes.'));
    return;
  }

  const { username, password } = req.body as { username?: string; password?: string };
  if (!username || !password) {
    res.status(400).setHeader('Content-Type', 'text/html; charset=utf-8');
    res.send(modLoginPage('Username and password required.'));
    return;
  }

  const mod = await mods.login(username, password, res);
  if (!mod) {
    logAbuse(hash, 'mod_login_failed', username.slice(0, 32));
    res.status(401).setHeader('Content-Type', 'text/html; charset=utf-8');
    res.send(modLoginPage('Wrong username or password.'));
    return;
  }

  await mods.audit(mod, 'login');
  res.redirect('/');
});

app.post('/mod/logout', async (req, res) => {
  await mods.logout(req, res);
  res.redirect('/');
});

app.get('/api/mod/me', async (req, res) => {
  const mod = await mods.modFromRequest(req);
  res.json(mod ? { username: mod.username, role: mod.role } : null);
});

app.get('/api/mod/actions', async (req, res) => {
  const mod = await mods.modFromRequest(req);
  if (!mod) {
    res.status(403).json({ error: 'forbidden' });
    return;
  }
  res.json(await mods.recentActions(100));
});

// --- Admin ------------------------------------------------------------------

function requireAdmin(req: express.Request, res: express.Response): boolean {
  if (!config.adminToken) {
    res.status(404).end();
    return false;
  }
  const given = req.get('x-admin-token') ?? '';
  if (given !== config.adminToken) {
    res.status(403).json({ error: 'forbidden' });
    return false;
  }
  return true;
}

app.get('/admin/abuse', async (req, res) => {
  if (!requireAdmin(req, res)) return;
  const { rows } = await query(
    `SELECT ip_hash, kind, detail, created_at FROM abuse_events
     ORDER BY created_at DESC LIMIT 200`,
  );
  const { rows: summary } = await query(
    `SELECT kind, count(*) AS n FROM abuse_events
     WHERE created_at > now() - interval '24 hours'
     GROUP BY kind ORDER BY n DESC`,
  );
  res.json({ recent: rows, last24h: summary });
});

app.get('/admin/mods', async (req, res) => {
  if (!requireAdmin(req, res)) return;
  res.json(await mods.listMods());
});

/** No self-signup anywhere: mod accounts exist only if an admin makes one. */
app.post('/admin/mods', async (req, res) => {
  if (!requireAdmin(req, res)) return;
  const { username, password, role } = req.body as {
    username?: string;
    password?: string;
    role?: string;
  };
  if (!username || !password) {
    res.status(400).json({ error: 'username and password required' });
    return;
  }
  try {
    const mod = await mods.createMod(
      username,
      password,
      role === 'admin' ? 'admin' : 'mod',
    );
    res.json({ ok: true, mod: { username: mod.username, role: mod.role } });
  } catch (err) {
    res.status(400).json({ error: String(err instanceof Error ? err.message : err) });
  }
});

app.delete('/admin/mods/:username', async (req, res) => {
  if (!requireAdmin(req, res)) return;
  await mods.disableMod(req.params.username ?? '');
  res.json({ ok: true });
});

app.post('/admin/ban', async (req, res) => {
  if (!requireAdmin(req, res)) return;
  const { ipHash: hash, reason } = req.body as { ipHash?: string; reason?: string };
  if (!hash) {
    res.status(400).json({ error: 'ipHash required' });
    return;
  }
  await banHash(hash, reason ?? 'manual');
  res.json({ ok: true });
});

app.post('/admin/unban', async (req, res) => {
  if (!requireAdmin(req, res)) return;
  const { ipHash: hash } = req.body as { ipHash?: string };
  if (!hash) {
    res.status(400).json({ error: 'ipHash required' });
    return;
  }
  await unbanHash(hash);
  res.json({ ok: true });
});

// --- Static client ----------------------------------------------------------

if (IS_PROD) {
  const clientDir = path.join(import.meta.dirname, 'client');
  app.use(express.static(clientDir, { maxAge: '1h', index: false }));
  app.get('/{*any}', (_req, res) => {
    res.sendFile(path.join(clientDir, 'index.html'));
  });
}

// --- Boot -------------------------------------------------------------------

const server = http.createServer(app);

/**
 * Bind the listening socket.
 *
 * Host matters more than it looks. Railway's proxy reaches containers over
 * IPv6, and binding '0.0.0.0' is IPv4-ONLY — the process comes up healthy,
 * logs that it is listening, and is still unreachable from the edge, which
 * surfaces as a 502 that looks nothing like a bind problem.
 *
 * '::' with ipv6Only unset is dual-stack: it accepts IPv6 and IPv4 both. That
 * is also Node's default when no host is given. We fall back to 0.0.0.0 for
 * the rare host with IPv6 disabled entirely.
 */
function listen(): Promise<void> {
  const preferred = process.env.BIND_HOST ?? '::';

  const tryHost = (host: string) =>
    new Promise<void>((resolve, reject) => {
      const onError = (err: NodeJS.ErrnoException) => {
        server.removeListener('listening', onListening);
        reject(err);
      };
      const onListening = () => {
        server.removeListener('error', onError);
        console.log(
          `[deadman] listening on [${host}]:${config.port} ` +
            `(${IS_PROD ? 'production' : 'development'})`,
        );
        resolve();
      };
      server.once('error', onError);
      server.once('listening', onListening);
      server.listen(config.port, host);
    });

  return tryHost(preferred).catch((err: NodeJS.ErrnoException) => {
    if (err.code === 'EAFNOSUPPORT' || err.code === 'EADDRNOTAVAIL') {
      console.warn(`[deadman] ${preferred} unavailable (${err.code}); falling back to 0.0.0.0`);
      return tryHost('0.0.0.0');
    }
    throw err;
  });
}

/**
 * Bind the port BEFORE touching the database.
 *
 * If initialisation runs first and the database isn't reachable, the process
 * exits without ever listening, and the platform reports a bare 502 with no
 * indication of why. Listening first means /healthz can say what's actually
 * wrong, and a slow database becomes a short delay rather than a crash loop.
 */
async function main(): Promise<void> {
  await listen();

  console.log('[deadman] connecting to postgres…');
  await waitForDb();
  await migrate();
  await refreshBans();
  await game.initGame();
  await chat.loadRecent(game.currentEra().id);
  await mods.loadSettings();
  attachHub(server);

  setInterval(() => void mods.sweepSessions(), 3600_000).unref();

  setReady();
  console.log('[deadman] ready');
}

async function shutdown(signal: string): Promise<void> {
  console.log(`[deadman] ${signal} received, closing`);
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 5000).unref();
}

process.on('SIGTERM', () => void shutdown('SIGTERM'));
process.on('SIGINT', () => void shutdown('SIGINT'));

main().catch((err) => {
  bootError = String(err instanceof Error ? err.message : err);
  console.error('[deadman] failed to start:', err);
  // Stay up briefly so /healthz can report the reason to whoever is looking,
  // then exit and let the platform restart us.
  setTimeout(() => process.exit(1), 10_000);
});
