import assert from 'node:assert/strict';
import test from 'node:test';
import type { Evidence } from '../src/evidence.js';
import { duelPoolReceiptsFromEvidence } from '../src/league/pool-receipts.js';
import type { TraceRecord } from '../src/trace.js';

function evidence(records: readonly TraceRecord[]): Evidence {
  return { run_id: 'pool-receipt-run', first_sequence: '1', last_sequence: String(records.length), segments: [], records };
}

test('duel pool shield qualification pairs client transitions with server ticks', () => {
  const records: TraceRecord[] = [
    { schema: 'client-mechanics-v1', seat: 1, tick: 44, kind: 'shield_blocking_transition', blocking: true },
    { schema: 'client-mechanics-v1', seat: 1, tick: 52, kind: 'shield_blocking_transition', blocking: false },
    {
      direction: 'plugin', protocol: 1, run_id: 'pool-receipt-run', sequence: '1', type: 'mechanics_receipt',
      payload: {
        at: { domain: 'match', value: '45' },
        receipts: [
          { seat: 1, kind: 'shield_blocking_transition', blocking: true },
          { seat: 1, kind: 'shield_blocking_transition', blocking: false },
        ],
      },
    },
  ];
  const receipts = duelPoolReceiptsFromEvidence(evidence(records), 'shield-user', 1, 'shield-run');
  assert.deepEqual(receipts, [
    { member: 'shield-user', action: 'shieldRaised', matchId: 'shield-run', status: 'paired' },
    { member: 'shield-user', action: 'shieldLowered', matchId: 'shield-run', status: 'paired' },
    { member: 'shield-user', action: 'healedWithPermittedItem', matchId: 'shield-run', status: 'neither' },
  ]);
});
