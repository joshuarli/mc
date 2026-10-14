import type { Bot } from "mineflayer";

/** Keeps movement controls active while a Mineflayer turn waits for physics to accept its yaw. */
export function startSprintCourse(bot: Pick<Bot, "setControlState" | "clearControlStates" | "look">) {
  bot.setControlState("forward", true);
  bot.setControlState("sprint", true);
  bot.setControlState("jump", false);

  return Object.freeze({
    turn: async (yaw: number, jumping: boolean): Promise<void> => {
      bot.setControlState("jump", jumping);
      await bot.look(yaw, 0);
    },
    stop: (): void => bot.clearControlStates(),
  });
}
