const CLIENT_QUARANTINE = 'this client is quarantined';

export interface ClientQuarantine {
  readonly seat: number;
  readonly tick: number;
  readonly reason: string;
}

export function isClientQuarantine(error: unknown): error is Error {
  return error instanceof Error && error.message.includes(CLIENT_QUARANTINE);
}
