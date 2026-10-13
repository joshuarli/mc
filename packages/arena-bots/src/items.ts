import {
  type EquipmentSlot,
  type KnownItem,
} from '@arena/core';
import type { Bot } from 'mineflayer';

type MineflayerItem = NonNullable<Bot['inventory']['slots'][number]>;

const MATERIAL_RATING: Readonly<Record<string, number>> = Object.freeze({
  leather: 1,
  wooden: 1,
  golden: 1,
  gold: 1,
  chainmail: 2,
  stone: 2,
  iron: 3,
  diamond: 4,
  netherite: 5,
});

const ARMOR_SLOT: Readonly<Record<string, Exclude<EquipmentSlot, 'weapon'>>> = Object.freeze({
  helmet: 'helmet',
  chestplate: 'chestplate',
  leggings: 'leggings',
  boots: 'boots',
});

/** Ratings order vanilla material tiers; the core compares them only within a gear slot. */
export function classifyItem(bot: Bot, item: MineflayerItem): KnownItem | null {
  if (bot.registry.foodsByName[item.name] !== undefined) return { kind: 'food' };

  const armor = /^(leather|chainmail|iron|golden|gold|diamond|netherite)_(helmet|chestplate|leggings|boots)$/.exec(item.name);
  if (armor !== null) {
    const rating = MATERIAL_RATING[armor[1]];
    const equipmentSlot = ARMOR_SLOT[armor[2]];
    if (rating === undefined || equipmentSlot === undefined) throw new Error(`unsupported armor item ${item.name}`);
    return { kind: 'armor', equipmentSlot, rating };
  }
  if (item.name === 'turtle_helmet') return { kind: 'armor', equipmentSlot: 'helmet', rating: 1 };

  const weapon = /^(wooden|stone|iron|golden|gold|diamond|netherite)_(sword|axe)$/.exec(item.name);
  if (weapon !== null) {
    const rating = MATERIAL_RATING[weapon[1]];
    if (rating === undefined) throw new Error(`unsupported weapon item ${item.name}`);
    return { kind: 'weapon', rating };
  }
  if (item.name === 'trident') return { kind: 'weapon', rating: 5 };
  return null;
}

export function mineflayerEquipmentDestination(slot: EquipmentSlot): 'hand' | 'head' | 'torso' | 'legs' | 'feet' {
  switch (slot) {
    case 'weapon': return 'hand';
    case 'helmet': return 'head';
    case 'chestplate': return 'torso';
    case 'leggings': return 'legs';
    case 'boots': return 'feet';
    default: return assertNever(slot);
  }
}

function assertNever(value: never): never {
  throw new Error(`unsupported equipment slot: ${String(value)}`);
}
