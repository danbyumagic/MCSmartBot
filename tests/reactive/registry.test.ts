import { describe, it, expect, vi } from "vitest";
import type { Reflex } from "../../src/reactive/types.js";
import { createReflexRegistry } from "../../src/reactive/registry.js";

const make = (name: string, priority: number, check = true): Reflex => ({
  name,
  priority,
  check: () => check,
  run: vi.fn().mockResolvedValue(undefined),
});

describe("ReflexRegistry", () => {
  it("returns reflexes ordered by priority desc", () => {
    const reg = createReflexRegistry([make("a", 10), make("b", 100), make("c", 50)]);
    expect(reg.all().map((r) => r.name)).toEqual(["b", "c", "a"]);
  });

  it("rejects duplicate names at construction", () => {
    expect(() => createReflexRegistry([make("a", 10), make("a", 20)])).toThrow(/duplicate/i);
  });

  it("findFiring returns the highest-priority reflex whose check passes", () => {
    const fake = {} as Parameters<Reflex["check"]>[0];
    const reg = createReflexRegistry([
      { name: "low", priority: 1, check: () => true, run: vi.fn() },
      { name: "high", priority: 100, check: () => false, run: vi.fn() },
      { name: "mid", priority: 50, check: () => true, run: vi.fn() },
    ]);
    expect(reg.findFiring(fake)?.name).toBe("mid");
  });

  it("findFiring returns null when no reflex's check passes", () => {
    const fake = {} as Parameters<Reflex["check"]>[0];
    const reg = createReflexRegistry([{ name: "x", priority: 10, check: () => false, run: vi.fn() }]);
    expect(reg.findFiring(fake)).toBeNull();
  });
});
