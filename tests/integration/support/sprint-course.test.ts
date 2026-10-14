import assert from "node:assert/strict";
import type { Bot } from "mineflayer";
import { test } from "node:test";

import { startSprintCourse } from "./sprint-course.js";

test("legal-player-course-controls", async () => {
  const controls = { forward: false, sprint: false, jump: false };
  let expectedJump = false;
  let turnCount = 0;
  const bot = {
    setControlState: (control: string, enabled: boolean): void => {
      if (control === "forward" || control === "sprint" || control === "jump") controls[control] = enabled;
    },
    clearControlStates: (): void => {
      controls.forward = false;
      controls.sprint = false;
      controls.jump = false;
    },
    look: async (): Promise<void> => {
      await Promise.resolve();
      turnCount += 1;
      assert.equal(controls.forward, true, "forward must stay held while the awaited turn advances physics");
      assert.equal(controls.sprint, true, "sprint must stay held while the awaited turn advances physics");
      assert.equal(controls.jump, expectedJump, "the course must apply the requested jump state before turning");
    },
  } as unknown as Pick<Bot, "setControlState" | "clearControlStates" | "look">;

  const course = startSprintCourse(bot);
  try {
    expectedJump = true;
    await course.turn(Math.PI, true);
    assert.deepStrictEqual(controls, { forward: true, sprint: true, jump: true });

    expectedJump = false;
    await course.turn(-Math.PI / 2, false);
    assert.deepStrictEqual(controls, { forward: true, sprint: true, jump: false });
    assert.equal(turnCount, 2);
  } finally {
    course.stop();
  }

  assert.deepStrictEqual(controls, { forward: false, sprint: false, jump: false });
});
