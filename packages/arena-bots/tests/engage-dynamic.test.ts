import assert from 'node:assert/strict';
import test from 'node:test';
import {
  combatBody,
  combatSelfBody,
  isCrosshairOnBody,
  isWithinMeleeReach,
  type CombatBody,
  type CombatSelfBody,
} from '@arena/core';
import { meleeAimPoint } from '../src/ballistics.js';
import { createCombatArena, Vec3, type CombatArena } from './combat-arena.js';

const WIDTH = 0.6;
const HEIGHT = 1.8;
const EYE = 1.62;
const ORBIT_RADIUS = 2.4;
const ORBIT_SPEED = 0.25;
const LOOK_LATENCY_TICKS = 1;
const OBSERVATION_LAG_TICKS = 1;
const KNOCKBACK = 0.6;
const COOLDOWN_TICKS = 13;
const HALF_HORIZONTAL_FOV = Math.PI / 3;
const HIT_RATE_GATE = 0.5;
const ORBIT_ATTEMPTS = 6;

type RunnableIntent = Parameters<CombatArena['runIntent']>[0];

const attackIntent = { kind: 'attack', target: 2 as never } as RunnableIntent;

interface AimedBodies {
  readonly self: CombatSelfBody;
  readonly target: CombatBody;
}

function aimedBodies(
  selfFeet: { readonly x: number; readonly y: number; readonly z: number },
  aim: { readonly x: number; readonly y: number; readonly z: number },
  targetFeet: { readonly x: number; readonly y: number; readonly z: number },
): AimedBodies {
  const dx = aim.x - selfFeet.x;
  const dy = aim.y - (selfFeet.y + EYE);
  const dz = aim.z - selfFeet.z;
  const yaw = Math.atan2(-dx, -dz);
  const pitch = Math.atan2(dy, Math.hypot(dx, dz));
  return {
    self: combatSelfBody({
      position: selfFeet,
      velocity: { x: 0, y: 0, z: 0 },
      yaw,
      pitch,
      width: WIDTH,
      height: HEIGHT,
      eyeHeight: EYE,
    }),
    target: combatBody({
      position: targetFeet,
      velocity: { x: 0, y: 0, z: 0 },
      yaw: 0,
      pitch: 0,
      width: WIDTH,
      height: HEIGHT,
    }),
  };
}

function shortestAngle(angle: number): number {
  return Math.atan2(Math.sin(angle), Math.cos(angle));
}

function legacyOrbitHitRate(attempts: number): number {
  const center = { x: 0.5, y: 1, z: 0.5 };
  const history: { readonly x: number; readonly y: number; readonly z: number }[] = [{
    x: center.x,
    y: center.y,
    z: center.z - ORBIT_RADIUS,
  }];
  let angle = 0;
  let radius = ORBIT_RADIUS;
  let yaw = 0;
  let pitch = 0;
  let hits = 0;
  const step = (): void => {
    angle += ORBIT_SPEED / radius;
    history.push({
      x: center.x + Math.sin(angle) * radius,
      y: center.y,
      z: center.z - Math.cos(angle) * radius,
    });
  };
  const observed = (): { readonly x: number; readonly y: number; readonly z: number } => (
    history[Math.max(0, history.length - 1 - OBSERVATION_LAG_TICKS)]!
  );
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    for (let tick = 0; tick < (attempt === 0 ? 0 : COOLDOWN_TICKS); tick += 1) step();
    let body = observed();
    const targetYaw = Math.atan2(-(body.x - center.x), -(body.z - center.z));
    if (Math.abs(shortestAngle(targetYaw - yaw)) > HALF_HORIZONTAL_FOV) continue;
    for (let look = 0; look < 2; look += 1) {
      const aim = { x: body.x, y: body.y + HEIGHT * 0.65, z: body.z };
      yaw = Math.atan2(-(aim.x - center.x), -(aim.z - center.z));
      pitch = Math.atan2(aim.y - (center.y + EYE), Math.hypot(aim.x - center.x, aim.z - center.z));
      for (let waited = 0; waited < LOOK_LATENCY_TICKS; waited += 1) step();
      body = observed();
    }
    const self = combatSelfBody({
      position: center,
      velocity: { x: 0, y: 0, z: 0 },
      yaw,
      pitch,
      width: WIDTH,
      height: HEIGHT,
      eyeHeight: EYE,
    });
    const target = combatBody({
      position: body,
      velocity: { x: 0, y: 0, z: 0 },
      yaw: 0,
      pitch: 0,
      width: WIDTH,
      height: HEIGHT,
    });
    if (!isWithinMeleeReach(self, target) || !isCrosshairOnBody(self, target)) continue;
    hits += 1;
    radius = Math.min(ORBIT_RADIUS + KNOCKBACK, radius + KNOCKBACK);
  }
  return hits / attempts;
}

test('orbiting melee target: a single 0.65 aim misses the hit-rate gate and a led strike clears it', async () => {
  const self = { x: 0.5, y: 1, z: 0.5 };
  const lateral = 0.55;
  const centerDistance = 3.3;
  const edgeFeet = {
    x: self.x + lateral,
    y: 1,
    z: self.z - Math.sqrt(centerDistance * centerDistance - lateral * lateral),
  };
  const eye = { x: self.x, y: self.y + EYE, z: self.z };
  const legacyAim = { x: edgeFeet.x, y: edgeFeet.y + HEIGHT * 0.65, z: edgeFeet.z };
  const ledAim = meleeAimPoint(eye, edgeFeet, WIDTH, HEIGHT, { x: 0, y: 0, z: 0 });
  const legacyEdge = aimedBodies(self, legacyAim, edgeFeet);
  const ledEdge = aimedBodies(self, ledAim, edgeFeet);
  assert.equal(isWithinMeleeReach(legacyEdge.self, legacyEdge.target), true);
  assert.equal(isCrosshairOnBody(legacyEdge.self, legacyEdge.target), false);
  assert.equal(isWithinMeleeReach(ledEdge.self, ledEdge.target), true);
  assert.equal(isCrosshairOnBody(ledEdge.self, ledEdge.target), true);

  const legacyRate = legacyOrbitHitRate(ORBIT_ATTEMPTS);
  assert.ok(legacyRate < HIT_RATE_GATE, `legacy single 0.65 aim rate ${legacyRate}`);

  const arena = createCombatArena({
    self,
    opponents: [{ id: 2, x: self.x, y: self.y, z: self.z - ORBIT_RADIUS }],
    lookLatencyTicks: LOOK_LATENCY_TICKS,
    observationLagTicks: OBSERVATION_LAG_TICKS,
  });
  let angle = 0;
  let radius = ORBIT_RADIUS;
  arena.bot.on('entityHurt', (hurt) => {
    if (hurt?.id === 2) radius = Math.min(ORBIT_RADIUS + KNOCKBACK, radius + KNOCKBACK);
  });
  const step = (): void => {
    angle += ORBIT_SPEED / radius;
    arena.setOpponent(2, {
      x: self.x + Math.sin(angle) * radius,
      y: self.y,
      z: self.z - Math.cos(angle) * radius,
    });
  };
  try {
    let successes = 0;
    const failures: string[] = [];
    for (let attempt = 0; attempt < ORBIT_ATTEMPTS; attempt += 1) {
      const result = await arena.runIntent(attackIntent, step);
      if (result.outcome.kind === 'succeeded') successes += 1;
      else failures.push(`${result.outcome.kind}:${JSON.stringify(arena.funnel.at(-1))}`);
    }
    const liveRate = successes / ORBIT_ATTEMPTS;
    assert.ok(
      liveRate >= HIT_RATE_GATE && liveRate > legacyRate,
      `legacy ${legacyRate} live ${liveRate} ${failures.join(' | ')}`,
    );
    assert.ok(arena.attacks.filter((swing) => swing.damaged).length === successes);
  } finally {
    await arena.close();
  }
});

test('melee aim settle stops with aimNotReady once the retry bound is spent', async () => {
  const spots = [
    { x: 0.5, y: 1, z: -1.2 },
    { x: 1.6, y: 1, z: -1.2 },
  ];
  const arena = createCombatArena({
    self: { x: 0.5, y: 1, z: 0.5 },
    opponents: [{ id: 2, ...spots[0]! }],
    lookLatencyTicks: 1,
  });
  let placed = 0;
  try {
    const result = await arena.runIntent(attackIntent, () => {
      placed += 1;
      const spot = spots[placed % spots.length]!;
      arena.setOpponent(2, spot);
    });
    assert.deepEqual(result.outcome, { kind: 'failed', cause: 'noProgress' });
    assert.ok(result.ticks <= 8, `aim settle ran for ${result.ticks} ticks`);
    assert.equal(arena.attacks.length, 0);
    const record = arena.funnel.at(-1);
    assert.ok(record?.kind === 'stopped' && record.reason === 'aimNotReady', JSON.stringify(record));
  } finally {
    await arena.close();
  }
});

function setWall(arena: CombatArena, solid: boolean): void {
  const state = solid ? arena.bot.registry.blocksByName.stone!.minStateId : 0;
  for (const x of [-1, 0, 1]) {
    for (const y of [1, 2]) arena.bot.world.setBlockStateId(new Vec3(x, y, -1), state);
  }
}

async function swingThenCooldown(arena: CombatArena, clearAfter: number): Promise<void> {
  const first = await arena.runIntent(attackIntent);
  assert.equal(first.outcome.kind, 'succeeded');
  const started = arena.tickCount();
  const second = await arena.runIntent(attackIntent, () => {
    setWall(arena, arena.tickCount() - started < clearAfter);
  });
  assert.equal(second.outcome.kind, clearAfter > 3 ? 'failed' : 'succeeded');
}

test('three blocked ticks during the attack cooldown still allow the next swing', async () => {
  const arena = createCombatArena({
    self: { x: 0.5, y: 1, z: 0.5 },
    opponents: [{ id: 2, x: 0.5, y: 1, z: -2 }],
  });
  try {
    await swingThenCooldown(arena, 3);
    assert.equal(arena.attacks.length, 2);
    assert.ok(arena.attacks.every((swing) => swing.damaged));
    const record = arena.funnel.at(-1);
    assert.ok(record?.kind === 'reached' && record.stage === 'clientResponse', JSON.stringify(record));
  } finally {
    await arena.close();
  }
});

test('a perception-cone miss during the attack cooldown still allows the next swing', async () => {
  const home = { x: 0.5, y: 1, z: -2 };
  const aside = { x: 6, y: 1, z: 0.5 };
  const arena = createCombatArena({
    self: { x: 0.5, y: 1, z: 0.5 },
    opponents: [{ id: 2, ...home }],
    lookLatencyTicks: 2,
  });
  try {
    const first = await arena.runIntent(attackIntent);
    assert.equal(first.outcome.kind, 'succeeded');
    const started = arena.tickCount();
    const second = await arena.runIntent(attackIntent, () => {
      const elapsed = arena.tickCount() - started;
      arena.setOpponent(2, elapsed < 3 ? aside : home);
    });
    assert.equal(second.outcome.kind, 'succeeded');
    assert.equal(arena.attacks.length, 2);
    assert.ok(arena.attacks.every((swing) => swing.damaged));
  } finally {
    await arena.close();
  }
});

test('a fourth consecutive blocked tick during the attack cooldown is a line-of-sight miss', async () => {
  const arena = createCombatArena({
    self: { x: 0.5, y: 1, z: 0.5 },
    opponents: [{ id: 2, x: 0.5, y: 1, z: -2 }],
  });
  try {
    const before = arena.attacks.length;
    await swingThenCooldown(arena, 4);
    assert.equal(arena.attacks.length, before + 1);
    const record = arena.funnel.at(-1);
    assert.ok(record?.kind === 'stopped' && record.reason === 'blockedLineOfSight', JSON.stringify(record));
  } finally {
    await arena.close();
  }
});
