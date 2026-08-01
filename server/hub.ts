import { WebSocketServer, WebSocket } from 'ws';
import type { Server } from 'node:http';
import { z } from 'zod';
import { config } from './config.ts';
import {
  ipHash,
  isBanned,
  limiters,
  logAbuse,
  acquireConnSlot,
  releaseConnSlot,
  shortHash,
} from './abuse.ts';
import { identityFromRequest, type User } from './identity.ts';
import * as game from './game.ts';
import * as chat from './chat.ts';
import { MAX_CHAT_LENGTH, MAX_WS_FRAME_BYTES } from '@shared/protocol.ts';
import type { ServerMessage } from '@shared/protocol.ts';
import type { BandId } from '@shared/bands.ts';

interface Conn {
  ws: WebSocket;
  /** Null for spectators: they receive everything, but cannot press or chat. */
  user: User | null;
  hash: string;
  hasPressed: boolean;
  band: BandId | null;
  violations: number;
  alive: boolean;
}

const conns = new Set<Conn>();

const ClientMessageSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('press') }),
  z.object({ type: z.literal('chat'), body: z.string().max(MAX_CHAT_LENGTH * 2) }),
  z.object({ type: z.literal('ping'), t: z.number() }),
]);

function send(c: Conn, msg: ServerMessage): void {
  if (c.ws.readyState === WebSocket.OPEN) c.ws.send(JSON.stringify(msg));
}

function broadcast(msg: ServerMessage): void {
  const payload = JSON.stringify(msg);
  for (const c of conns) {
    if (c.ws.readyState === WebSocket.OPEN) c.ws.send(payload);
  }
}

/** Players connected right now who still hold an unspent press. */
function loadedCount(): number {
  let n = 0;
  for (const c of conns) if (c.user && !c.hasPressed) n++;
  return n;
}

async function pushLeaderboards(target?: Conn): Promise<void> {
  const eraId = game.currentEra().id;
  const [era, allTime] = await Promise.all([
    game.eraLeaderboard(eraId),
    game.allTimeLeaderboard(),
  ]);
  const msg: ServerMessage = { type: 'leaderboard', era, allTime };
  target ? send(target, msg) : broadcast(msg);
}

async function pushGauge(target?: Conn): Promise<void> {
  const gauge = await game.gauge(game.currentEra().id);
  const msg: ServerMessage = { type: 'gauge', gauge };
  target ? send(target, msg) : broadcast(msg);
}

async function pushCloseCalls(target?: Conn): Promise<void> {
  const presses = await game.closeCalls(game.currentEra().id);
  const msg: ServerMessage = { type: 'closeCalls', presses };
  target ? send(target, msg) : broadcast(msg);
}

function violation(c: Conn, kind: 'ws_malformed' | 'ws_oversize', detail: string): void {
  c.violations++;
  logAbuse(c.hash, kind, detail);
  if (c.violations >= 3) {
    send(c, { type: 'error', code: 'protocol', message: 'Too many bad frames.' });
    c.ws.close(1008, 'protocol');
  }
}

async function handlePress(c: Conn): Promise<void> {
  if (!c.user) {
    send(c, {
      type: 'error',
      code: 'spectator',
      message: 'Too many new players from your network — you can watch, but not press yet.',
    });
    return;
  }
  const result = await game.press(c.user);

  if (!result.ok) {
    send(c, { type: 'error', code: result.code, message: result.message });
    // Re-sync: if they already pressed, make sure their UI knows it.
    if (result.code === 'already_pressed' || result.code === 'network_pressed') {
      c.hasPressed = true;
    }
    return;
  }

  game.applyExpiry(result.expiresAt);
  c.hasPressed = true;
  c.band = result.press.band;

  for (const other of conns) {
    send(other, {
      type: 'press',
      press: result.press,
      expiresAt: result.expiresAt,
      closeCall: result.closeCall,
      mine: other === c,
    });
  }

  await Promise.all([pushLeaderboards(), pushGauge()]);
  if (result.closeCall) await pushCloseCalls();
}

async function handleChat(c: Conn, body: string): Promise<void> {
  if (!c.user) {
    send(c, { type: 'error', code: 'spectator', message: 'Spectators cannot chat.' });
    return;
  }
  const result = await chat.postMessage(c.user, game.currentEra().id, c.band, body);
  if (!result.ok) {
    send(c, { type: 'error', code: result.code, message: result.message });
    return;
  }
  broadcast({ type: 'chat', message: result.message });
}

export function attachHub(server: Server): void {
  const wss = new WebSocketServer({
    server,
    path: '/ws',
    // ws closes the connection itself on a larger frame; this is the memory
    // guard that stops a single client from allocating unbounded buffers.
    maxPayload: MAX_WS_FRAME_BYTES,
  });

  wss.on('connection', async (ws, req) => {
    const hash = ipHash(req);

    if (isBanned(hash)) {
      logAbuse(hash, 'banned_attempt', 'ws');
      ws.close(1008, 'banned');
      return;
    }
    if (!limiters.wsHandshake.take(hash)) {
      logAbuse(hash, 'ws_rate');
      ws.close(1013, 'rate limited');
      return;
    }
    if (!acquireConnSlot(hash)) {
      logAbuse(hash, 'ws_concurrent');
      ws.close(1013, 'too many connections');
      return;
    }

    let released = false;
    const release = () => {
      if (!released) {
        released = true;
        releaseConnSlot(hash);
      }
    };

    // No valid cookie means the visitor is past the identity-minting cap (or
    // arrived before /api/identity ran). They connect as a spectator rather
    // than being turned away — watching is the half of this game that isn't
    // gated on having a press to spend.
    const user = await identityFromRequest(req);

    const era = game.currentEra();
    const mine = user ? await game.myPress(era.id, user.id) : null;

    const c: Conn = {
      ws,
      user,
      hash,
      hasPressed: mine !== null,
      band: mine?.band ?? null,
      violations: 0,
      alive: true,
    };
    conns.add(c);

    ws.on('pong', () => {
      c.alive = true;
    });

    send(c, {
      type: 'hello',
      userId: user?.id ?? null,
      name: user?.name ?? null,
      spectator: user === null,
      hasPressed: c.hasPressed,
      myPress: mine,
      serverTime: Date.now(),
      expiresAt: era.expiresAt,
      eraId: era.id,
      eraStartedAt: era.startedAt,
      roundSeconds: config.roundSeconds,
    });
    send(c, { type: 'chatBackfill', messages: chat.backfill() });
    void pushLeaderboards(c);
    void pushGauge(c);
    void pushCloseCalls(c);

    ws.on('message', (data, isBinary) => {
      if (isBinary) {
        violation(c, 'ws_malformed', 'binary frame');
        return;
      }
      let parsed: unknown;
      try {
        parsed = JSON.parse(data.toString());
      } catch {
        violation(c, 'ws_malformed', 'bad json');
        return;
      }
      const msg = ClientMessageSchema.safeParse(parsed);
      if (!msg.success) {
        violation(c, 'ws_malformed', 'schema');
        return;
      }

      switch (msg.data.type) {
        case 'ping':
          // Clock sync. The client pairs this with its own send time to derive
          // an offset, so the countdown renders smoothly despite jitter.
          send(c, { type: 'pong', t: msg.data.t, serverTime: Date.now() });
          break;
        case 'press':
          void handlePress(c);
          break;
        case 'chat':
          void handleChat(c, msg.data.body);
          break;
      }
    });

    ws.on('close', () => {
      conns.delete(c);
      release();
    });
    ws.on('error', () => {
      conns.delete(c);
      release();
    });
  });

  // Drop connections that stopped answering, so `watching` stays honest.
  setInterval(() => {
    for (const c of conns) {
      if (!c.alive) {
        c.ws.terminate();
        conns.delete(c);
        continue;
      }
      c.alive = false;
      c.ws.ping();
    }
  }, 30_000).unref();

  // Deadline broadcast. We send the deadline, never the remaining seconds.
  setInterval(() => {
    if (conns.size === 0) return;
    const era = game.currentEra();
    broadcast({
      type: 'state',
      serverTime: Date.now(),
      expiresAt: era.expiresAt,
      eraId: era.id,
      watching: conns.size,
      loaded: loadedCount(),
    });
  }, 1000).unref();

  game.gameEvents.on('flatline', (deadEra, next: game.EraState) => {
    // New era: every press is refunded and the room starts clean.
    chat.clearRing();
    for (const c of conns) {
      c.hasPressed = false;
      c.band = null;
    }
    broadcast({
      type: 'flatline',
      deadEra,
      eraId: next.id,
      expiresAt: next.expiresAt,
      eraStartedAt: next.startedAt,
    });
    void pushLeaderboards();
    void pushGauge();
    void pushCloseCalls();
  });

  console.log(`[hub] websocket ready (max frame ${MAX_WS_FRAME_BYTES}B)`);
}

export function connectionCount(): number {
  return conns.size;
}

export function debugSummary(): string {
  const networks = new Set([...conns].map((c) => shortHash(c.hash))).size;
  return `${conns.size} connected, ${loadedCount()} loaded, ${networks} networks`;
}
