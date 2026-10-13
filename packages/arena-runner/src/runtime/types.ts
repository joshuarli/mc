import type { Intent, SkillOutcome } from '@arena/core';
import type { Bot } from 'mineflayer';
import type { OutcomePayload, ControlMessage, PreparePayload } from '../control/index.js';
import type { FileIdentity } from '../owned-files/index.js';
import type { PreparedRun } from '../prepare.js';
import type { RunnerCommandEnvelope } from './session.js';
import type { PlayerIdentity, StoppedPlayerStats } from './observations.js';

export type RuntimeAuthorityEvent = Extract<ControlMessage, {
  readonly type: 'public_clock' | 'public_state' | 'elimination' | 'outcome';
}>;

export interface ChunkReceipt {
  readonly x: number;
  readonly z: number;
}

export interface EntityReceipt {
  readonly id: number;
  readonly type: string;
  readonly position: Readonly<{ x: number; y: number; z: number }>;
}

export interface MineflayerReceiptSnapshot {
  readonly chunkColumns: readonly ChunkReceipt[];
  readonly entities: readonly EntityReceipt[];
}

export interface RuntimeCompetitorHandle {
  readonly seat: number;
  readonly identity: PlayerIdentity;
  readonly bot: Bot;
  readonly client: import('@arena/bots').MineflayerArenaClient;
  chunkReceipts(): MineflayerReceiptSnapshot;
}

export interface RuntimeSpectatorHandle {
  readonly identity: PlayerIdentity;
  readonly bot: Bot;
  chunkReceipts(): MineflayerReceiptSnapshot;
}

export interface ActiveRunEvaluationContext {
  readonly preparedRun: PreparedRun;
  readonly ready: Extract<ControlMessage, { readonly type: 'ready' }>;
  readonly prepare: RunnerCommandEnvelope & { readonly type: 'prepare'; readonly payload: PreparePayload };
  readonly gameAddress: Readonly<{ host: '127.0.0.1'; port: 25565 }>;
  readonly competitors: readonly RuntimeCompetitorHandle[];
  readonly spectators: readonly RuntimeSpectatorHandle[];
  events(): readonly RuntimeAuthorityEvent[];
  start(): Promise<void>;
  waitForOutcome(): Promise<OutcomePayload>;
  reconnectCompetitor(seat: number): Promise<RuntimeCompetitorHandle>;
}

export type ActiveRunEvaluator = (
  context: ActiveRunEvaluationContext,
  signal: AbortSignal,
) => void | Promise<void>;

export interface RuntimePolicyDecision {
  readonly seat: number;
  readonly intent: Intent;
  readonly outcome: SkillOutcome;
}

export interface CompletedOwnedRun {
  readonly runId: string;
  readonly ready: Extract<ControlMessage, { readonly type: 'ready' }>;
  readonly events: readonly RuntimeAuthorityEvent[];
  readonly outcome: OutcomePayload;
  readonly trace: Readonly<{
    segments: readonly Readonly<{
      relativePath: Buffer;
      identity: FileIdentity;
      byteLength: number;
    }>[];
    totalByteLength: number;
  }>;
  readonly competitors: readonly PlayerIdentity[];
  readonly spectators: readonly PlayerIdentity[];
  readonly stats: readonly StoppedPlayerStats[];
}
