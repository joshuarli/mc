export const BORDER_UNKNOWN_REASONS = [
  'noPacketReceived',
  'fractionalCenter',
  'invalidRadius',
] as const;

export type BorderUnknownReason = typeof BORDER_UNKNOWN_REASONS[number];

export const BORDER_UNKNOWN_DIAGNOSTIC_THRESHOLD = 100;

export type ClientDiagnosticRecord = {
  readonly kind: 'borderUnknown';
  readonly reason: BorderUnknownReason;
  readonly consecutiveObservations: number;
};

export type ClientDiagnosticSink = (record: ClientDiagnosticRecord) => void;
