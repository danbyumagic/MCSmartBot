import { describe, it, expect } from "vitest";
import { z } from "zod";
import { defineSkill } from "../../src/skills/types.js";
import { createSkillRegistry } from "../../src/skills/registry.js";

const noop = defineSkill({
  name: "noop",
  description: "x",
  policy: { minimumRole: "viewer", effect: "read", reversible: false, mission: "public" },
  params: z.object({}),
  run: async () => ({ ok: true, summary: "" }),
});

const another = defineSkill({
  name: "another",
  description: "y",
  policy: { minimumRole: "viewer", effect: "read", reversible: false, mission: "public" },
  params: z.object({}),
  run: async () => ({ ok: true, summary: "" }),
});

describe("SkillRegistry", () => {
  it("registers and looks up skills by name", () => {
    const reg = createSkillRegistry([noop, another]);
    expect(reg.get("noop")?.name).toBe("noop");
    expect(reg.get("another")?.name).toBe("another");
    expect(reg.get("missing")).toBeUndefined();
  });

  it("lists all registered skills in registration order", () => {
    const reg = createSkillRegistry([noop, another]);
    expect(reg.all().map((s) => s.name)).toEqual(["noop", "another"]);
  });

  it("throws on duplicate names at construction time", () => {
    expect(() => createSkillRegistry([noop, noop])).toThrow(/duplicate/i);
  });
});
