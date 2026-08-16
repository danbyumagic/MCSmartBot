import { EventEmitter } from "node:events";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Vec3 } from "vec3";

vi.mock("mineflayer-pathfinder", () => {
  class FakeMovements {
    allowFreeMotion = false;
    canOpenDoors = false;
    allowParkour = true;
    allowEntityDetection = true;
    canDig = true;
    constructor(_bot: unknown) {}
  }
  class FakeGoalFollow {
    constructor(
      public entity: unknown,
      public range: number,
    ) {}
  }
  return {
    default: {
      goals: { GoalFollow: FakeGoalFollow },
      Movements: FakeMovements,
      pathfinder: vi.fn(),
    },
  };
});

import {
  PathfindingFailure,
  followPlayerUntilAborted,
  pathfindTo,
} from "../../src/skills/pathfinder.js";

function makeBot(goto: ReturnType<typeof vi.fn>) {
  const emitter = new EventEmitter() as EventEmitter & Record<string, any>;
  const pathfinder = {
    goto,
    goal: null,
    thinkTimeout: 0,
    tickTimeout: 0,
    setGoal: vi.fn((goal: unknown) => {
      pathfinder.goal = goal;
    }),
    setMovements: vi.fn(),
  };
  Object.assign(emitter, {
    pathfinder,
    clearControlStates: vi.fn(),
    loadPlugin: vi.fn(),
    entity: { position: new Vec3(0, 64, 0) },
  });
  return emitter;
}

afterEach(() => {
  vi.useRealTimers();
});

describe("pathfinder recovery", () => {
  it("retries a timeout with a longer, door-aware profile", async () => {
    vi.useFakeTimers();
    const goto = vi.fn()
      .mockRejectedValueOnce(new Error("Took to long to decide path to goal!"))
      .mockResolvedValueOnce(undefined);
    const bot = makeBot(goto);
    const promise = pathfindTo(bot as any, {} as any, new AbortController().signal);

    await vi.advanceTimersByTimeAsync(300);
    const result = await promise;

    expect(result).toEqual({
      attempts: 2,
      recoveries: 1,
      profile: "stable-door-aware",
    });
    expect(goto).toHaveBeenCalledTimes(2);
    expect(bot.pathfinder.thinkTimeout).toBe(15_000);
    expect(bot.pathfinder.setMovements).toHaveBeenCalledTimes(2);
    const recoveryMovements = bot.pathfinder.setMovements.mock.calls[1][0];
    expect(recoveryMovements).toMatchObject({
      canOpenDoors: true,
      allowParkour: false,
    });
  });

  it("returns structured failure after exhausting recovery profiles", async () => {
    vi.useFakeTimers();
    const goto = vi.fn().mockRejectedValue(new Error("No path to the goal!"));
    const bot = makeBot(goto);
    const promise = pathfindTo(bot as any, {} as any, new AbortController().signal);
    const expectation = expect(promise).rejects.toMatchObject({
      name: "PathfindingFailure",
      kind: "no_path",
      attempts: 3,
      profile: "relaxed-entities",
    });

    await vi.advanceTimersByTimeAsync(600);
    await expectation;
    expect(goto).toHaveBeenCalledTimes(3);
  });

  it("does not retry a goal changed by another controller", async () => {
    const goto = vi.fn().mockRejectedValue(
      new Error("The goal was changed before it could be completed!"),
    );
    const bot = makeBot(goto);

    await expect(
      pathfindTo(bot as any, {} as any, new AbortController().signal),
    ).rejects.toBeInstanceOf(PathfindingFailure);
    expect(goto).toHaveBeenCalledTimes(1);
  });

  it("stops continuous follow when the target stays unavailable", async () => {
    vi.useFakeTimers();
    const bot = makeBot(vi.fn());
    const promise = followPlayerUntilAborted(
      bot as any,
      () => undefined,
      2,
      new AbortController().signal,
    );
    const expectation = expect(promise).rejects.toMatchObject({
      kind: "target_unavailable",
      causeMessage: "target entity unavailable",
    });

    await vi.advanceTimersByTimeAsync(10_100);
    await expectation;
    expect(bot.pathfinder.setGoal).toHaveBeenLastCalledWith(null);
  });
});
