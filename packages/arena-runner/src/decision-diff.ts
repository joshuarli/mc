import {
  compileCandidate,
  rehydratePolicyReplayInput,
  type CandidateId,
  type CompiledCandidate,
  type DecisionExplanation,
  type ExplainedDecision,
} from '@arena/core';
import { canonicalJson } from './canonical.js';
import type { Evidence } from './evidence.js';

const MAX_ENTRIES = 200;

export interface DecisionDiffRequest {
  readonly baseline: CandidateId;
  readonly challenger: CandidateId;
  readonly seat?: number;
}

interface Side {
  readonly goal: string;
  readonly intent: string;
  readonly reason: DecisionExplanation['reason'];
  readonly alternatives: DecisionExplanation['alternatives'];
}

export function decisionDiffJson(evidence: Evidence, request: DecisionDiffRequest): object {
  const baseline = compileCandidate(request.baseline);
  const challenger = compileCandidate(request.challenger);
  const entries: object[] = [];
  const transitions: Record<string, number> = {};
  const reasons: Record<string, number> = {};
  let compared = 0;
  let differing = 0;
  for (const record of evidence.records) {
    if (record.schema !== 'policy-replay-v4' || typeof record.seat !== 'number') continue;
    if (request.seat !== undefined && record.seat !== request.seat) continue;
    const baselineSide = explainRecorded(baseline, record.input);
    const challengerSide = explainRecorded(challenger, record.input);
    if (baselineSide === undefined || challengerSide === undefined) continue;
    compared += 1;
    if (canonicalJson({ g: baselineSide.decision.goal, i: baselineSide.decision.intent })
        === canonicalJson({ g: challengerSide.decision.goal, i: challengerSide.decision.intent })) continue;
    differing += 1;
    const transition = `${baselineSide.decision.goal.kind}/${baselineSide.decision.intent.kind}`
      + ` -> ${challengerSide.decision.goal.kind}/${challengerSide.decision.intent.kind}`;
    transitions[transition] = (transitions[transition] ?? 0) + 1;
    const reason = challengerSide.explanation.reason;
    reasons[reason] = (reasons[reason] ?? 0) + 1;
    if (entries.length < MAX_ENTRIES) {
      const observation = (record.input as { observation?: { tick?: number } }).observation;
      entries.push({
        seat: record.seat,
        sequence: record.sequence,
        tick: observation?.tick ?? null,
        recorded: {
          goal: (record.decision as { goal: { kind: string } }).goal.kind,
          intent: (record.decision as { intent: { kind: string } }).intent.kind,
        },
        baseline: side(baselineSide),
        challenger: side(challengerSide),
      });
    }
  }
  return {
    schema: 1,
    run_id: evidence.run_id,
    basis: 'recorded_observations_and_memory_replayed_through_both_candidates',
    baseline: baseline.semanticId,
    challenger: challenger.semanticId,
    ...(request.seat === undefined ? {} : { seat: request.seat }),
    compared,
    differing,
    transitions,
    challenger_reasons: reasons,
    entries,
    entries_truncated: differing > entries.length,
  };
}

function side(explained: ExplainedDecision): Side {
  return {
    goal: explained.decision.goal.kind,
    intent: explained.decision.intent.kind,
    reason: explained.explanation.reason,
    alternatives: explained.explanation.alternatives,
  };
}

function explainRecorded(candidate: CompiledCandidate, input: unknown): ExplainedDecision | undefined {
  const restored = rehydratePolicyReplayInput(input);
  if (restored.schema !== 'policy-input-v4') return undefined;
  if (restored.opening === null) {
    return candidate.explain(restored.observation, restored.memory, restored.random, restored.feedback);
  }
  const { decision, explanation } = candidate.explainOpening(
    restored.observation, restored.memory, restored.random, restored.feedback,
    { style: restored.opening.style, state: restored.opening.state },
  );
  const { openingState: _openingState, ...plain } = decision;
  return { decision: plain, explanation };
}
