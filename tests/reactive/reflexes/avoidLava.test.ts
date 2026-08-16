import { describe, it, expect } from "vitest";
import { isLavaAdjacent } from "../../../src/reactive/reflexes/avoidLava.js";

function makeBot(opts: {
  selfPos?: { x: number; y: number; z: number };
  blockAt?: (pos: { x: number; y: number; z: number }) => { name?: string } | null;
}) {
  const pos = opts.selfPos ?? { x: 0, y: 64, z: 0 };
  return {
    entity: { position: pos },
    blockAt: opts.blockAt ?? (() => null),
  } as unknown as Parameters<typeof isLavaAdjacent>[0];
}

describe("avoidLava isLavaAdjacent", () => {
  it("returns false when no lava is near", () => {
    expect(isLavaAdjacent(makeBot({ blockAt: () => ({ name: "stone" }) }))).toBe(false);
  });

  it("returns true when lava is one block away", () => {
    expect(
      isLavaAdjacent(makeBot({
        blockAt: (p) => (p.x === 1 ? { name: "lava" } : { name: "stone" }),
      })),
    ).toBe(true);
  });

  it("matches flowing_lava as well", () => {
    expect(
      isLavaAdjacent(makeBot({
        blockAt: (p) => (p.y === 65 ? { name: "flowing_lava" } : { name: "stone" }),
      })),
    ).toBe(true);
  });

  it("returns false when bot has not spawned", () => {
    expect(isLavaAdjacent({} as Parameters<typeof isLavaAdjacent>[0])).toBe(false);
  });
});
