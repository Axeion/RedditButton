/**
 * WebSocket wire protocol, shared by server and client.
 *
 * Design rule that matters: the server broadcasts the DEADLINE (`expiresAt`,
 * epoch ms), never the remaining seconds. Clients interpolate locally against a
 * measured clock offset, so network jitter never makes the number jump. And a
 * client press message carries no time at all — the server stamps it.
 */

import type { BandId } from './bands.ts';

export interface PressDTO {
  id: number;
  eraId: number;
  name: string;
  secondsLeft: number;
  band: BandId;
  pressedAt: number;
  rank?: number;
}

export interface ChatDTO {
  id: number;
  name: string;
  body: string;
  band: BandId | null;
  createdAt: number;
}

export interface EraSummary {
  id: number;
  startedAt: number;
  endedAt: number | null;
  durationMs: number;
  totalPresses: number;
  top: PressDTO[];
  lastHand: PressDTO | null;
}

export interface ModInfo {
  username: string;
  role: 'mod' | 'admin';
}

export interface ChatSettingsDTO {
  slowModeSeconds: number;
  locked: boolean;
}

export interface GaugeCounts {
  counts: Record<BandId, number>;
  total: number;
}

/** Server -> client. */
export type ServerMessage =
  | {
      type: 'hello';
      /** Null for spectators — visitors past the identity-minting cap. */
      userId: string | null;
      name: string | null;
      spectator: boolean;
      hasPressed: boolean;
      myPress: PressDTO | null;
      serverTime: number;
      expiresAt: number;
      eraId: number;
      eraStartedAt: number;
      roundSeconds: number;
      /** Set when this connection is authenticated as a moderator. */
      mod: ModInfo | null;
      chatSettings: ChatSettingsDTO;
    }
  | { type: 'pong'; t: number; serverTime: number }
  | { type: 'state'; serverTime: number; expiresAt: number; eraId: number; watching: number; loaded: number }
  | { type: 'press'; press: PressDTO; expiresAt: number; closeCall: boolean; mine: boolean }
  | { type: 'chat'; message: ChatDTO }
  | { type: 'chatBackfill'; messages: ChatDTO[] }
  | { type: 'leaderboard'; era: PressDTO[]; allTime: PressDTO[] }
  | { type: 'gauge'; gauge: GaugeCounts }
  | { type: 'closeCalls'; presses: PressDTO[] }
  | { type: 'flatline'; deadEra: EraSummary; eraId: number; expiresAt: number; eraStartedAt: number }
  | { type: 'chatDelete'; ids: number[]; by: string }
  | { type: 'chatSettings'; settings: ChatSettingsDTO }
  | { type: 'modResult'; ok: boolean; message: string }
  | { type: 'error'; code: string; message: string };

/** Client -> server. */
export type ClientMessage =
  | { type: 'press' }
  | { type: 'chat'; body: string }
  | { type: 'ping'; t: number }
  // Moderation. Every one of these is re-authorised server-side against the
  // session cookie — the client saying it is a mod means nothing.
  | { type: 'modDelete'; messageId: number }
  | { type: 'modPurge'; messageId: number }
  | { type: 'modTimeout'; messageId: number; minutes: number }
  | { type: 'modSlowMode'; seconds: number }
  | { type: 'modLock'; locked: boolean };

export const MAX_CHAT_LENGTH = 300;
/** Anything larger is a probe, not a player. */
export const MAX_WS_FRAME_BYTES = 4096;
