import { describe, it, expect, vi, beforeEach } from "vitest";
import { createSetFlightTool } from "../../src/agent/flightTool.js";
import { setFlightEnabled, isFlightEnabled } from "../../src/skills/pathfinder.js";
import { Vec3 } from "vec3";

const makeBot = (gameMode: "survival" | "creative" = "survival") => {
  const position = new Vec3(0, 64, 0);
  return {
    pathfinder: undefined,
    game: { gameMode },
    entity: { position },
    creative: {
      startFlying: vi.fn(),
      stopFlying: vi.fn(),
      flyTo: vi.fn(async (destination: Vec3) => {
        position.set(destination.x, destination.y, destination.z);
      }),
    },
    _client: { write: vi.fn() },
    clearControlStates: vi.fn(),
  } as unknown as Parameters<typeof createSetFlightTool>[0];
};

beforeEach(() => {
  setFlightEnabled(makeBot(), false);
});

describe("createSetFlightTool", () => {
  it("runs /fly and performs takeoff when enabling outside Creative", async () => {
    const runCommand = vi.fn().mockResolvedValue(["Flight mode enabled for SmartBot."]);
    const bot = makeBot();
    const tool = createSetFlightTool(bot, runCommand);
    const result = await tool.handler({ enabled: true });
    expect(runCommand).toHaveBeenCalledWith("fly");
    expect(result.ok).toBe(true);
    expect(result.summary).toMatch(/enabled/);
    expect(isFlightEnabled()).toBe(true);
  });

  it("runs /fly when disabling outside Creative", async () => {
    const runCommand = vi.fn().mockResolvedValue(["Flight mode disabled."]);
    const bot = makeBot();
    setFlightEnabled(bot, true);
    const tool = createSetFlightTool(bot, runCommand);
    const result = await tool.handler({ enabled: false });
    expect(runCommand).toHaveBeenCalledWith("fly");
    expect(result.ok).toBe(true);
    expect(isFlightEnabled()).toBe(false);
  });

  it("no-ops when flight is already in the target state", async () => {
    const runCommand = vi.fn();
    const bot = makeBot();
    const tool = createSetFlightTool(bot, runCommand);
    const result = await tool.handler({ enabled: false });
    expect(runCommand).not.toHaveBeenCalled();
    expect(result.summary).toMatch(/already disabled/);
  });

  it("returns ok:false when the server rejects /fly (no permission / unknown command)", async () => {
    const runCommand = vi.fn().mockResolvedValue(["Unknown command. Type \"/help\" for help."]);
    const bot = makeBot();
    const tool = createSetFlightTool(bot, runCommand);
    const result = await tool.handler({ enabled: true });
    expect(result.ok).toBe(false);
    expect(result.summary).toMatch(/unavailable/i);
    expect(isFlightEnabled()).toBe(false);
  });

  it("activates Creative flight without calling /fly", async () => {
    const runCommand = vi.fn();
    const bot = makeBot("creative");
    const tool = createSetFlightTool(bot, runCommand);
    const result = await tool.handler({ enabled: true });
    expect(result.ok).toBe(true);
    expect(runCommand).not.toHaveBeenCalled();
    expect(bot.creative.startFlying).toHaveBeenCalled();
    expect(bot.creative.flyTo).toHaveBeenCalled();
    expect((bot as any)._client.write).toHaveBeenCalledWith("abilities", { flags: 2 });
  });
});
