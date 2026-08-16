import { describe, it, expect, vi } from "vitest";
import { gotoCoords } from "../../../src/skills/navigation/gotoCoords.js";
import type { SkillContext } from "../../../src/skills/types.js";

function makeCtx(overrides: Partial<SkillContext> = {}): SkillContext {
  const log = {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    trace: vi.fn(),
    fatal: vi.fn(),
    child: () => log,
    level: "error",
    bindings: () => ({}),
  } as unknown as SkillContext["log"];
  return {
    bot: {} as SkillContext["bot"],
    signal: new AbortController().signal,
    log,
    reportProgress: vi.fn(),
    ...overrides,
  };
}

describe("gotoCoords", () => {
  it("rejects non-finite coordinates via the schema", () => {
    expect(() => gotoCoords.params.parse({ x: Number.NaN, y: 0, z: 0 })).toThrow();
  });

  it("rejects ranges outside the world", () => {
    expect(() => gotoCoords.params.parse({ x: 0, y: 5000, z: 0 })).toThrow();
  });

  it("accepts a valid set of integer-like coordinates", () => {
    const parsed = gotoCoords.params.parse({ x: 100, y: 64, z: -200 });
    expect(parsed).toEqual({ x: 100, y: 64, z: -200, range: 1 });
  });
});
