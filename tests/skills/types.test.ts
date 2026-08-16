import { describe, it, expect } from "vitest";
import { z } from "zod";
import { defineSkill } from "../../src/skills/types.js";

describe("defineSkill", () => {
  it("preserves name, description, schema, and immutable policy", () => {
    const skill = defineSkill({
      name: "noop",
      description: "Does nothing.",
      policy: { minimumRole: "viewer", effect: "read", reversible: false, mission: "public" },
      params: z.object({ x: z.number() }),
      run: async () => ({ ok: true, summary: "did nothing" }),
    });
    expect(skill.name).toBe("noop");
    expect(skill.description).toMatch(/nothing/);
    expect(skill.params.parse({ x: 1 })).toEqual({ x: 1 });
    expect(Object.isFrozen(skill.policy)).toBe(true);
  });

  it("rejects params that violate the schema", () => {
    const skill = defineSkill({
      name: "noop",
      description: "x",
      policy: { minimumRole: "viewer", effect: "read", reversible: false, mission: "public" },
      params: z.object({ x: z.number() }),
      run: async () => ({ ok: true, summary: "" }),
    });
    expect(() => skill.params.parse({ x: "not a number" })).toThrow();
  });
});
