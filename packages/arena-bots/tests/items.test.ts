import assert from 'node:assert/strict';
import test from 'node:test';
import type { Bot } from 'mineflayer';
import { classifyItem } from '../src/items.js';

const bot = { registry: { foodsByName: {} } } as unknown as Bot;
const item = (name: string) => ({ name }) as Parameters<typeof classifyItem>[1];

test('containers hand over bows and arrows because both are known ranged supplies', () => {
  assert.deepEqual(classifyItem(bot, item('bow')), { kind: 'rangedWeapon' });
  for (const arrow of ['arrow', 'tipped_arrow', 'spectral_arrow']) {
    assert.deepEqual(classifyItem(bot, item(arrow)), { kind: 'ammunition' });
  }
  assert.equal(classifyItem(bot, item('crossbow')), null);
});
