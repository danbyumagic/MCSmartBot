import { describe, it, expect } from "vitest";
import { meleeDefense, nearestHostile } from "../../../src/reactive/reflexes/meleeDefense.js";

function makeBot(opts: {
  selfPos?: { x: number; y: number; z: number };
  entities?: Record<string, { name?: string; position?: { x: number; y: number; z: number } }>;
}) {
  const pos = opts.selfPos ?? { x: 0, y: 64, z: 0 };
  const withDistanceTo = (p: { x: number; y: number; z: number }) => ({
    ...p,
    distanceTo: (q: { x: number; y: number; z: number }) => {
      const dx = p.x - q.x, dy = p.y - q.y, dz = p.z - q.z;
      return Math.sqrt(dx * dx + dy * dy + dz * dz);
    },
  });
  const entities: Record<string, unknown> = {};
  for (const [id, e] of Object.entries(opts.entities ?? {})) {
    entities[id] = e.position
      ? { ...e, position: withDistanceTo(e.position) }
      : e;
  }
  return {
    entity: { position: withDistanceTo(pos) },
    entities,
  } as unknown as Parameters<typeof meleeDefense.check>[0];
}

describe("meleeDefense", () => {
  it("check() is false when no hostile is in range", () => {
    expect(meleeDefense.check(makeBot({ entities: {} }))).toBe(false);
    expect(meleeDefense.check(makeBot({
      entities: { e1: { name: "cow", position: { x: 1, y: 64, z: 0 } } },
    }))).toBe(false);
  });

  it("check() is true when a hostile is within 2 blocks", () => {
    const bot = makeBot({
      entities: { e1: { name: "zombie", position: { x: 1, y: 64, z: 1 } } },
    });
    expect(meleeDefense.check(bot)).toBe(true);
  });

  it("check() is false when hostiles are present but >2 blocks away", () => {
    const bot = makeBot({
      entities: { e1: { name: "skeleton", position: { x: 5, y: 64, z: 0 } } },
    });
    expect(meleeDefense.check(bot)).toBe(false);
  });

  it("nearestHostile prefers the closest hostile in range", () => {
    const bot = makeBot({
      entities: {
        far:   { name: "zombie",   position: { x: 3, y: 64, z: 0 } },
        close: { name: "skeleton", position: { x: 0, y: 64, z: 1 } },
      },
    });
    const found = nearestHostile(bot, 5);
    expect(found?.entity.name).toBe("skeleton");
  });

  it("nearestHostile ignores passive entities", () => {
    const bot = makeBot({
      entities: { e1: { name: "cow", position: { x: 1, y: 64, z: 0 } } },
    });
    expect(nearestHostile(bot, 5)).toBeNull();
  });
});
