import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  pathfindTo: vi.fn(),
  setFlightEnabled: vi.fn(),
}));

vi.mock("../../src/skills/pathfinder.js", () => ({
  goals: {
    GoalNear: class {
      constructor(
        public x: number,
        public y: number,
        public z: number,
        public range: number,
      ) {}
    },
  },
  pathfindTo: mocks.pathfindTo,
  pathfindingFailureDetails: vi.fn(() => ({})),
  setFlightEnabled: mocks.setFlightEnabled,
  isFlightEnabled: vi.fn(() => false),
}));

import {
  CollectBlockFailure,
  collectBlockWithRecovery,
} from "../../src/skills/collectblock.js";

describe("collectblock recovery", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("approaches and retries after collectblock path timeout", async () => {
    mocks.pathfindTo.mockResolvedValueOnce({
      attempts: 2,
      recoveries: 1,
      profile: "stable-door-aware",
    });
    const collect = vi.fn()
      .mockRejectedValueOnce(new Error("Took to long to decide path to goal!"))
      .mockResolvedValueOnce(undefined);
    const bot = {
      collectBlock: { collect },
    } as any;
    const block = {
      name: "oak_log",
      position: { x: 4, y: 65, z: 6 },
    } as any;

    const result = await collectBlockWithRecovery(
      bot,
      block,
      new AbortController().signal,
    );

    expect(result).toMatchObject({
      attempts: 2,
      approach: { attempts: 2, recoveries: 1 },
    });
    expect(mocks.pathfindTo).toHaveBeenCalledOnce();
    expect(collect).toHaveBeenCalledTimes(2);
    expect(mocks.setFlightEnabled).toHaveBeenCalled();
  });

  it("does not pathfind around a non-navigation collection error", async () => {
    const bot = {
      collectBlock: {
        collect: vi.fn().mockRejectedValue(new Error("inventory full")),
      },
    } as any;

    await expect(collectBlockWithRecovery(
      bot,
      { name: "stone", position: { x: 0, y: 64, z: 0 } } as any,
      new AbortController().signal,
    )).rejects.toBeInstanceOf(CollectBlockFailure);
    expect(mocks.pathfindTo).not.toHaveBeenCalled();
  });
});
