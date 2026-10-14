import type { ResourceReference } from '@arena/spec';
import { RunnerError } from '../errors.js';
import { actionFunnelReport } from '../funnel-report.js';
import { matchQuality, type MatchQuality } from '../seat-quality.js';
import { createOwnedDirectory, OwnedFilesError, readOwnedFile, stageOwnedFile } from '../owned-files/index.js';
import { prepareRun, resolveScenarioResource } from '../prepare.js';
import { readStoppedRunEvidence } from '../runtime/inspect.js';
import { runPreparedRun } from '../runtime/run.js';
import type { MatchObservation, MatchPlan, MatchRunner } from './harness.js';

const MAX_SCENARIO_BYTES = 256 * 1024;

export interface LiveMatchRunnerOptions {
  readonly helperPath: string;
  readonly ownedRoot: Buffer;
  readonly javaExecutable: string;
  readonly paperJarPath: string;
  readonly pluginJarPath: string;
  readonly leagueId: string;
  readonly scenarioPath: Buffer;
  readonly scenarioSource: string;
}

export function seededScenarioSource(
  source: string,
  seed: number,
  mapPath: string,
  policyPath: string,
): string {
  const replacements: readonly [RegExp, string][] = [
    [/^seed = \d+$/m, `seed = ${seed}`],
    [/^map = ".*"$/m, `map = "${mapPath}"`],
    [/^policy = ".*"$/m, `policy = "${policyPath}"`],
  ];
  let text = source;
  for (const [pattern, replacement] of replacements) {
    if (text.match(new RegExp(pattern.source, 'gm'))?.length !== 1) {
      throw new RunnerError('invalid_input', 'league scenario', { kind: 'scenario_field_not_unique' });
    }
    text = text.replace(pattern, replacement);
  }
  return text;
}

export class LiveMatchRunner implements MatchRunner {
  readonly #options: LiveMatchRunnerOptions;
  readonly #prepared = new Set<number>();

  constructor(options: LiveMatchRunnerOptions) {
    this.#options = options;
  }

  async run(plan: MatchPlan, signal: AbortSignal): Promise<MatchObservation> {
    const options = this.#options;
    const scenarioPath = await this.#seedScenario(plan.worldSeed, signal);
    const runId = `${options.leagueId.slice(0, 24)}-${plan.matchId}`;
    const preparedRun = await prepareRun(options.helperPath, options.ownedRoot, scenarioPath, runId, signal);
    const seatCandidates = new Map<number, { id: typeof plan.candidate.id; params: Readonly<Record<string, number>> }>();
    for (const seat of plan.candidateSeats) seatCandidates.set(seat, { id: plan.candidate.id, params: plan.candidate.params });
    for (const seat of plan.opponentSeats) seatCandidates.set(seat, { id: plan.opponent.id, params: plan.opponent.params });
    let completed: Awaited<ReturnType<typeof runPreparedRun>>;
    try {
      completed = await runPreparedRun({
      preparedRun,
      helperPath: options.helperPath,
      ownedRoot: options.ownedRoot,
      javaExecutable: options.javaExecutable,
      paperJarPath: options.paperJarPath,
      pluginJarPath: options.pluginJarPath,
      acceptMinecraftEula: true,
      ephemeralGamePort: true,
      seatCandidates,
      signal,
    });
    } catch (error) {
      if (signal.aborted || !(error instanceof RunnerError) || error.category === 'cancelled') throw error;
      return Object.freeze({
        status: 'failed' as const, reason: error.source.kind, runId,
        quality: await this.#partialQuality(runId),
      });
    }
    if (completed.outcome.kind === 'abort') {
      return Object.freeze({
        status: 'failed' as const, reason: `abort_${completed.outcome.reason}`, runId,
        quality: await this.#partialQuality(completed.runId),
      });
    }
    const evidence = await readStoppedRunEvidence({
      helperPath: options.helperPath, ownedRoot: options.ownedRoot, runId: completed.runId,
    });
    const attacks: Record<number, { engaged: number; issued: number }> = {};
    const funnel = actionFunnelReport(evidence) as undefined | {
      seats: { seat: number; funnel: { attack: { engaged: number; passed: Record<string, number> } } }[];
    };
    for (const entry of funnel?.seats ?? []) {
      attacks[entry.seat] = { engaged: entry.funnel.attack.engaged, issued: entry.funnel.attack.passed.issued ?? 0 };
    }
    let disconnects = 0;
    for (const event of completed.events) {
      if (event.type === 'elimination') {
        disconnects += event.payload.eliminations.filter((entry) => entry.cause === 'disconnect').length;
      }
    }
    const outcome = completed.outcome.kind === 'winner'
      ? { kind: 'winner' as const, seat: completed.outcome.winner_seat }
      : { kind: 'draw' as const };
    return Object.freeze({
      status: 'completed' as const,
      outcome,
      survivors: completed.outcome.survivors,
      disconnects,
      degraded: completed.degraded !== undefined,
      attacks,
      quality: matchQuality(evidence),
      runId: completed.runId,
    });
  }

  async #partialQuality(runId: string): Promise<MatchQuality | null> {
    try {
      const evidence = await readStoppedRunEvidence({
        helperPath: this.#options.helperPath, ownedRoot: this.#options.ownedRoot, runId,
      });
      return matchQuality(evidence);
    } catch (error) {
      if (error instanceof RunnerError) return null;
      throw error;
    }
  }

  async #seedScenario(seed: number, signal: AbortSignal): Promise<Buffer> {
    const options = this.#options;
    const directory = `.work/arena/league/${options.leagueId}/scenarios`;
    const path = Buffer.from(`${directory}/seed-${seed}.toml`);
    if (this.#prepared.has(seed)) return path;
    const originalSource = options.scenarioSource;
    const mapReference = /^map = "(.*)"$/m.exec(originalSource)?.[1];
    const policyReference = /^policy = "(.*)"$/m.exec(originalSource)?.[1];
    if (mapReference === undefined || policyReference === undefined) {
      throw new RunnerError('invalid_input', 'league scenario', { kind: 'scenario_references_missing' });
    }
    const up = '../'.repeat(directory.split('/').length);
    const relative = (reference: string): string =>
      `${up}${resolveScenarioResource({ scenarioPath: options.scenarioPath, reference: reference as ResourceReference }).toString('utf8')}`;
    const text = seededScenarioSource(originalSource, seed, relative(mapReference), relative(policyReference));
    try {
      await createOwnedDirectory({ helperPath: options.helperPath, ownedRoot: options.ownedRoot, relativePath: Buffer.from(directory), signal });
    } catch (error) {
      if (!(error instanceof OwnedFilesError) || error.category !== 'conflict') throw error;
    }
    try {
      await stageOwnedFile({
        helperPath: options.helperPath, ownedRoot: options.ownedRoot, relativePath: path,
        contents: Buffer.from(text, 'utf8'), maxBytes: MAX_SCENARIO_BYTES, signal,
      });
    } catch (error) {
      if (!(error instanceof OwnedFilesError) || error.category !== 'conflict') throw error;
      const existing = await readOwnedFile({
        helperPath: options.helperPath, ownedRoot: options.ownedRoot, relativePath: path, maxBytes: MAX_SCENARIO_BYTES, signal,
      });
      if (existing.toString('utf8') !== text) {
        throw new RunnerError('corrupt_evidence', 'league scenario', { kind: 'seeded_scenario_changed', field: String(seed) });
      }
    }
    this.#prepared.add(seed);
    return path;
  }
}
