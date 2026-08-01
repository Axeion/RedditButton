import express from 'express';
import http from 'node:http';
import path from 'node:path';
import { config, IS_PROD } from './config.ts';
import { migrate } from './db.ts';
import { ipHash, shortHash, limiters, logAbuse, isBanned, refreshBans, banHash, unbanHash } from './abuse.ts';
import { ensureIdentity } from './identity.ts';
import * as game from './game.ts';
import * as chat from './chat.ts';
import { attachHub, connectionCount } from './hub.ts';
import { renderCard } from './card.ts';
import { sharePage, graveyardPage } from './pages.ts';
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

app.get('/healthz', async (req, res) => {
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
  } catch {
    res.status(503).json({ ok: false });
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

/**
 * Identity is minted here rather than on the HTML response, because a
 * WebSocket upgrade can read cookies but cannot set them — the cookie must
 * already exist by the time the socket opens. Works identically behind the
 * Vite dev proxy and in production.
 */
app.get('/api/identity', async (req, res) => {
  const result = await ensureIdentity(req, res);
  if (!result.ok) {
    res.status(result.code === 'banned' ? 403 : 429).json({ error: result.code, message: result.message });
    return;
  }
  res.json({ id: result.user.id, name: result.user.name, minted: result.minted });
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

async function main(): Promise<void> {
  await migrate();
  await refreshBans();
  await game.initGame();
  await chat.loadRecent(game.currentEra().id);
  attachHub(server);

  server.listen(config.port, () => {
    console.log(`[deadman] listening on :${config.port} (${IS_PROD ? 'production' : 'development'})`);
  });
}

async function shutdown(signal: string): Promise<void> {
  console.log(`[deadman] ${signal} received, closing`);
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 5000).unref();
}

process.on('SIGTERM', () => void shutdown('SIGTERM'));
process.on('SIGINT', () => void shutdown('SIGINT'));

main().catch((err) => {
  console.error('[deadman] failed to start', err);
  process.exit(1);
});
