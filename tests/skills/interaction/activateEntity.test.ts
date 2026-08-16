import { beforeEach, describe, expect, it, vi } from "vitest";
import { Vec3 } from "vec3";
import type { SkillContext } from "../../../src/skills/types.js";

const { pathfindTo } = vi.hoisted(() => ({ pathfindTo: vi.fn() }));

vi.mock("../../../src/skills/pathfinder.js", () => ({
  goals: {
    GoalNear: class GoalNear {
      constructor(
        public readonly x: number,
        public readonly y: number,
        public readonly z: number,
        public readonly range: number,
      ) {}
    },
  },
  pathfindTo,
}));

import { activateEntity } from "../../../src/skills/interaction/activateEntity.js";

function entity(id: number, name: string, type: string, x: number, extras: Record<string, unknown> = {}) {
  return { id, name, type, position: new Vec3(x, 64, 0), isValid: true, ...extras };
}

function botWith(targets: Record<number, object>) {
  const self = entity(0, "player", "player", 0, { username: "SmartBot" });
  return {
    entity: self,
    entities: { 0: self, ...targets } as Record<number, any>,
    players: {},
    activateEntity: vi.fn(async () => undefined),
  };
}

function context(bot: unknown, controller = new AbortController()): SkillContext {
  const log = {
    debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn(), trace: vi.fn(), fatal: vi.fn(),
    child: () => log, level: "error", bindings: () => ({}),
  } as unknown as SkillContext["log"];
  return {
    bot: bot as SkillContext["bot"], signal: controller.signal, log, reportProgress: vi.fn(),
  };
}

beforeEach(() => pathfindTo.mockReset().mockResolvedValue(undefined));

describe("activateEntity", () => {
  it("is a public operator world interaction with bounded selector input", () => {
    expect(activateEntity.policy).toEqual({
      minimumRole: "operator", effect: "world-change", reversible: false, mission: "public",
    });
    expect(activateEntity.params.parse({ selector: { entityId: 9 } })).toEqual({ selector: { entityId: 9 } });
    expect(() => activateEntity.params.parse({ selector: { entityId: 9, username: "Alice" } })).toThrow();
  });

  it("resolves a live entity and activates only that entity", async () => {
    const villager = entity(9, "villager", "mob", 2);
    const bot = botWith({ 9: villager });

    const result = await activateEntity.run({ selector: { entityId: 9 } }, context(bot));

    expect(bot.activateEntity).toHaveBeenCalledWith(villager);
    expect(result).toMatchObject({ ok: true, data: { target: { id: 9, name: "villager" } } });
  });

  it("routes only to a bounded position and refuses a selector that despawned while routing", async () => {
    const horse = entity(9, "horse", "mob", 8);
    const bot = botWith({ 9: horse });
    pathfindTo.mockImplementation(async () => { delete bot.entities[9]; });

    const result = await activateEntity.run({ selector: { entityId: 9 } }, context(bot));

    expect(pathfindTo).toHaveBeenCalledWith(bot, expect.objectContaining({ x: 8, y: 64, z: 0, range: 2 }), expect.any(AbortSignal));
    expect(bot.activateEntity).not.toHaveBeenCalled();
    expect(result).toMatchObject({ ok: false, code: "TARGET_UNAVAILABLE" });
  });

  it("maps a Mineflayer rejection to a technical server failure", async () => {
    const horse = entity(9, "horse", "mob", 2);
    const bot = botWith({ 9: horse });
    bot.activateEntity.mockRejectedValue(new Error("interaction denied"));

    const result = await activateEntity.run({ selector: { entityId: 9 } }, context(bot));

    expect(result).toMatchObject({ ok: false, code: "SERVER_REJECTED", details: { message: "interaction denied" } });
  });

  it("does not resolve or activate after cancellation", async () => {
    const controller = new AbortController();
    controller.abort();
    const bot = botWith({ 9: entity(9, "horse", "mob", 2) });

    const result = await activateEntity.run({ selector: { entityId: 9 } }, context(bot, controller));

    expect(bot.activateEntity).not.toHaveBeenCalled();
    expect(result).toMatchObject({ ok: false, code: "INTERRUPTED" });
  });
});
