import type {
  ActionFunnelSink,
  ClientDiagnosticSink,
  AgentObservation,
  SkillCancellation,
  SkillOutcome,
} from '@arena/core';
import type { Bot } from 'mineflayer';
import {
  bindEntityActionStringMapperFeature,
  bindPlayerCollisionDimensions,
  bindProtocol775VelocityUnits,
} from './mineflayer-compat.js';
import { MineflayerObserver } from './observer.js';
import type { ArenaSkillIntent } from './skill-intent.js';
import { SkillOwner } from './skills.js';

export type { ArenaSkillIntent } from './skill-intent.js';
export { PathDiagnosticRing } from './path-diagnostics.js';
export type {
  PathDiagnosticClock,
  PathDiagnosticExternalOwner,
  PathDiagnosticOptions,
  PathDiagnosticRecord,
} from './path-diagnostics.js';

export { createMineflayerCivilizationClient } from './civilization-client.js';
export type {
  CivilizationRosterMember,
  CivilizationTeamReportInput,
  MineflayerCivilizationClient,
  MineflayerCivilizationClientOptions,
} from './civilization-client.js';

export interface MineflayerArenaClient {
  observe(tick: number): AgentObservation;
  /** Runs a core policy intent or awaits exact arrival for the bot-only block navigation intent. */
  run(intent: ArenaSkillIntent): Promise<SkillOutcome>;
  cancel(reason: SkillCancellation): Promise<void>;
  close(): Promise<void>;
}

const funnelHolders = new WeakMap<MineflayerArenaClient, { current: ActionFunnelSink | null }>();

/** Routes this client's engagement records to a sink, replacing the creation-time sink; null detaches. */
export function attachActionFunnelSink(client: MineflayerArenaClient, sink: ActionFunnelSink | null): void {
  const holder = funnelHolders.get(client);
  if (holder === undefined) throw new Error('client was not created by createMineflayerArenaClient');
  holder.current = sink;
}

export interface MineflayerArenaClientOptions {
  readonly funnel?: ActionFunnelSink;
  readonly diagnostic?: ClientDiagnosticSink;
}

/** Connects one Mineflayer client's received state to the arena observation and skill contracts. */
export function createMineflayerArenaClient(bot: Bot, options: MineflayerArenaClientOptions = {}): MineflayerArenaClient {
  bindPlayerCollisionDimensions(bot);
  bindEntityActionStringMapperFeature(bot);
  const funnelHolder: { current: ActionFunnelSink | null } = { current: options.funnel ?? null };
  const observer = new MineflayerObserver(bot, undefined, options.diagnostic ?? null);
  let disposeVelocityUnits = (): void => undefined;
  let skills: SkillOwner;
  try {
    disposeVelocityUnits = bindProtocol775VelocityUnits(bot);
    skills = new SkillOwner(bot, observer, null, (record) => funnelHolder.current?.(record));
  } catch (error) {
    disposeVelocityUnits();
    observer.close();
    throw error;
  }
  let closePromise: Promise<void> | null = null;

  const client: MineflayerArenaClient = {
    observe: (tick) => observer.observe(tick),
    run: (intent) => skills.run(intent),
    cancel: (reason) => skills.cancel(reason),
    close: () => {
      closePromise ??= skills.close().finally(() => {
        disposeVelocityUnits();
        observer.close();
      });
      return closePromise;
    },
  };
  funnelHolders.set(client, funnelHolder);
  return client;
}
