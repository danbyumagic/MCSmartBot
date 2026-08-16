import { beforeEach, describe, expect, it, vi } from "vitest";
import { Vec3 } from "vec3";
import type { Bot } from "mineflayer";
import {
  activateFlight,
  deactivateFlight,
  flyToPosition,
  gameModeAllowsFlight,
} from "../../src/skills/flight.js";
import { isFlightEnabled, setFlightEnabled } from "../../src/skills/pathfinder.js";

function makeBot(gameMode: "survival" | "creative" = "creative") {
  const position = new Vec3(0, 64, 0);
  const write = vi.fn();
  const startFlying = vi.fn();
  const stopFlying = vi.fn();
  const flyTo = vi.fn(async (destination: Vec3) => {
    position.set(destination.x, destination.y, destination.z);
  });
  const bot = {
    game: { gameMode },
    entity: { position },
    creative: { startFlying, stopFlying, flyTo },
    _client: { write },
    clearControlStates: vi.fn(),
    pathfinder: undefined,
  } as unknown as Bot;
  return { bot, write, startFlying, stopFlying, flyTo };
}

beforeEach(() => {
  setFlightEnabled(makeBot().bot, false);
});

describe("flight controller", () => {
  it("recognizes Creative and Spectator as direct-flight modes", () => {
    expect(gameModeAllowsFlight(makeBot("creative").bot)).toBe(true);
    expect(gameModeAllowsFlight(makeBot("survival").bot)).toBe(false);
  });

  it("sends the vanilla flying ability flag and takes off", async () => {
    const { bot, write, startFlying, flyTo } = makeBot();
    await activateFlight(bot);
    expect(write).toHaveBeenCalledWith("abilities", { flags: 2 });
    expect(startFlying).toHaveBeenCalled();
    expect(flyTo).toHaveBeenCalled();
    expect(bot.entity.position.y).toBeCloseTo(65.25);
    expect(isFlightEnabled()).toBe(true);
  });

  it("flies to fixed xyz coordinates in bounded segments", async () => {
    const { bot, flyTo } = makeBot();
    await activateFlight(bot, false);
    const result = await flyToPosition(
      bot,
      new Vec3(10, 70, -4),
      1,
      new AbortController().signal,
    );
    expect(result.mode).toBe("flight");
    expect(result.segments).toBeGreaterThan(1);
    expect(flyTo).toHaveBeenCalled();
    expect(bot.entity.position.distanceTo(new Vec3(10, 70, -4))).toBeLessThanOrEqual(1);
  });

  it("clears the flying flag and restores gravity control when disabled", async () => {
    const { bot, write, stopFlying } = makeBot();
    await activateFlight(bot, false);
    deactivateFlight(bot);
    expect(write).toHaveBeenLastCalledWith("abilities", { flags: 0 });
    expect(stopFlying).toHaveBeenCalled();
    expect(isFlightEnabled()).toBe(false);
  });
});
