import {
  combatBody,
  combatSelfBody,
  type CombatBody,
  type CombatSelfBody,
} from '@arena/core';
import type { Bot } from 'mineflayer';

type MineflayerEntity = Bot['entity'];

interface PhysicalEntity {
  readonly position: { readonly x: number; readonly y: number; readonly z: number };
  readonly velocity: { readonly x: number; readonly y: number; readonly z: number };
  readonly yaw: number;
  readonly pitch: number;
  readonly width: number;
  readonly height: number;
}

export function readCombatBody(entity: MineflayerEntity): CombatBody {
  return combatBody(physicalMeasurement(entity));
}

export function readCombatSelfBody(entity: MineflayerEntity): CombatSelfBody {
  const eyeHeight = (entity as MineflayerEntity & { readonly eyeHeight?: number }).eyeHeight;
  if (typeof eyeHeight !== 'number') throw new TypeError('Mineflayer player entity has no eye height');
  return combatSelfBody({ ...physicalMeasurement(entity), eyeHeight });
}

function physicalMeasurement(entity: MineflayerEntity): PhysicalEntity {
  const { position, velocity, yaw, pitch, width, height } = entity as MineflayerEntity & Partial<PhysicalEntity>;
  if (position === undefined || velocity === undefined) {
    throw new TypeError(`entity ${entity.id} has no position or velocity`);
  }
  if (typeof yaw !== 'number' || typeof pitch !== 'number' || typeof width !== 'number' || typeof height !== 'number') {
    throw new TypeError(`entity ${entity.id} has no orientation or bounding box`);
  }
  return { position, velocity, yaw, pitch, width, height };
}
