import { seatId, type SeatId } from './observation.js';

const U64_MASK = 0xffff_ffff_ffff_ffffn;
const SPLITMIX_INCREMENT = 0x9e37_79b9_7f4a_7c15n;
const POLICY_STREAM_KEY = 0x504f_4c49_4359_0000n;
const SEARCH_STREAM_KEY = 0x5345_4152_4348_0000n;
const SETUP_STREAM_KEY = 0x5345_5455_5000_0000n;

export type RandomStream =
  | { readonly kind: 'policy'; readonly seat: SeatId }
  | { readonly kind: 'search'; readonly seat: SeatId }
  | { readonly kind: 'setup' };

export const RandomStream = Object.freeze({
  policy(seat: SeatId): RandomStream {
    return Object.freeze({ kind: 'policy', seat: seatId(seat) });
  },
  search(seat: SeatId): RandomStream {
    return Object.freeze({ kind: 'search', seat: seatId(seat) });
  },
  setup(): RandomStream {
    return Object.freeze({ kind: 'setup' });
  },
});

export class DeterministicRandom {
  private state: bigint;

  constructor(seed: bigint) {
    assertU64(seed, 'random seed');
    this.state = seed;
  }

  static forStream(seed: bigint, stream: RandomStream): DeterministicRandom {
    assertU64(seed, 'random seed');
    const key = randomStreamKey(stream);
    return new DeterministicRandom(mix64(seed ^ key));
  }

  /** Restores the exact generator state recorded before a policy decision. */
  static fromState(state: bigint): DeterministicRandom {
    return new DeterministicRandom(state);
  }

  snapshotState(): bigint {
    assertU64(this.state, 'random state');
    return this.state;
  }

  nextU64(): bigint {
    this.state = (this.state + SPLITMIX_INCREMENT) & U64_MASK;
    return mix64(this.state);
  }

  nextEightWay(): number {
    return Number(this.nextU64() & 7n);
  }
}

function randomStreamKey(stream: RandomStream): bigint {
  if (stream.kind === 'policy') {
    return POLICY_STREAM_KEY ^ BigInt(assertSeatId(stream.seat));
  }
  if (stream.kind === 'search') {
    return SEARCH_STREAM_KEY ^ BigInt(assertSeatId(stream.seat));
  }
  if (stream.kind === 'setup') {
    return SETUP_STREAM_KEY;
  }
  throw new TypeError(`unknown random stream kind: ${String((stream as { kind?: unknown }).kind)}`);
}

function mix64(input: bigint): bigint {
  let value = input & U64_MASK;
  value = ((value ^ (value >> 30n)) * 0xbf58_476d_1ce4_e5b9n) & U64_MASK;
  value = ((value ^ (value >> 27n)) * 0x94d0_49bb_1331_11ebn) & U64_MASK;
  return (value ^ (value >> 31n)) & U64_MASK;
}

function assertU64(value: bigint, label: string): void {
  if (typeof value !== 'bigint' || value < 0n || value > U64_MASK) {
    throw new RangeError(`${label} must be an unsigned 64-bit bigint`);
  }
}

function assertSeatId(value: number): SeatId {
  return seatId(value);
}
