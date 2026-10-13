export interface SkillProgress {
  readonly completedSteps: number;
  readonly totalSteps: number;
}

export function skillProgress(completedSteps: number, totalSteps: number): SkillProgress {
  if (!Number.isSafeInteger(totalSteps) || totalSteps <= 0 || totalSteps > 65_535) {
    throw new RangeError(`skill total steps must be between 1 and 65535, received ${totalSteps}`);
  }
  if (!Number.isSafeInteger(completedSteps) || completedSteps <= 0 || completedSteps >= totalSteps) {
    throw new RangeError(`skill progress must be between 1 and ${totalSteps - 1}, received ${completedSteps}`);
  }
  return Object.freeze({ completedSteps, totalSteps });
}

export type SkillFailure = 'preconditionsNotMet' | 'noProgress' | 'serverRejected' | 'timedOut';
export type SkillCancellation = 'replaced' | 'agentEliminated' | 'shutdown';

export type SkillOutcome =
  | { readonly kind: 'pending' }
  | { readonly kind: 'progress'; readonly progress: SkillProgress }
  | { readonly kind: 'succeeded' }
  | { readonly kind: 'failed'; readonly cause: SkillFailure }
  | { readonly kind: 'cancelled'; readonly reason: SkillCancellation };
