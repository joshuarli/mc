import type { PathDiagnosticRecord } from "@arena/bots";
import type { BlockPosition } from "@arena/core";

export interface RampArrivalReceipt {
  readonly clientMs: number;
  readonly authorityTick: number | null;
  readonly position: Readonly<{ x: number; y: number; z: number }>;
}

export interface RampPathDiagnosticArtifact {
  readonly target: BlockPosition;
  readonly ownArrivalReceipt: RampArrivalReceipt | null;
  readonly observerArrivalReceipt: RampArrivalReceipt | null;
  readonly records: readonly PathDiagnosticRecord[];
}

export function serializeRampPathDiagnosticArtifact(artifact: RampPathDiagnosticArtifact): Buffer {
  return Buffer.from(JSON.stringify({
    target: artifact.target,
    ownArrivalReceipt: artifact.ownArrivalReceipt,
    observerArrivalReceipt: artifact.observerArrivalReceipt,
    records: artifact.records,
  }), "utf8");
}
