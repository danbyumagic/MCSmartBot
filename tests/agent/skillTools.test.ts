import { describe, it, expect, vi } from "vitest";
import { z } from "zod";
import { defineSkill } from "../../src/skills/types.js";
import { createSkillTool } from "../../src/agent/skillTools.js";

const actorProvider = () => ({
  username: "Builder",
  role: "operator" as const,
  source: "minecraft-chat" as const,
});

describe("createSkillTool", () => {
  it("produces a ToolDef whose name/description/schema match the skill", () => {
    const skill = defineSkill({
      name: "demo",
      description: "Does a demo.",
      policy: { minimumRole: "viewer", effect: "read", reversible: false, mission: "public" },
      params: z.object({ x: z.number() }),
      run: async () => ({ ok: true, summary: "done" }),
    });
    const tool = createSkillTool(skill, { run: vi.fn() } as any, actorProvider);
    expect(tool.name).toBe("demo");
    expect(tool.description).toBe("Does a demo.");
    expect(tool.inputSchema.parse({ x: 1 })).toEqual({ x: 1 });
    expect(tool.policy).toEqual(skill.policy);
    expect(tool.policy).not.toBe(skill.policy);
  });

  it("invokes runner.run with the skill and validated params", async () => {
    const skill = defineSkill({
      name: "demo",
      description: "x",
      policy: { minimumRole: "viewer", effect: "read", reversible: false, mission: "public" },
      params: z.object({ x: z.number() }),
      run: async () => ({ ok: true, summary: "done" }),
    });
    const runner = { run: vi.fn().mockResolvedValue({ ok: true, summary: "done" }) } as any;
    const tool = createSkillTool(skill, runner, actorProvider);
    const result = await tool.handler({ x: 7 });
    expect(runner.run).toHaveBeenCalledWith(skill, { x: 7 }, {
      execution: expect.objectContaining({
        actor: expect.objectContaining({ username: "Builder", role: "operator" }),
      }),
    });
    expect(result.ok).toBe(true);
    expect(result.summary).toBe("done");
  });

  it("returns ok:false summary when runner reports failure", async () => {
    const skill = defineSkill({
      name: "demo",
      description: "x",
      policy: { minimumRole: "viewer", effect: "read", reversible: false, mission: "public" },
      params: z.object({}),
      run: async () => ({ ok: true, summary: "" }),
    });
    const runner = {
      run: vi.fn().mockResolvedValue({
        ok: false,
        summary: "boom",
        code: "NO_PATH",
        recoverable: true,
        details: { target: "base" },
      }),
    } as any;
    const tool = createSkillTool(skill, runner, actorProvider);
    const result = await tool.handler({});
    expect(result.ok).toBe(false);
    expect(result.summary).toBe("boom");
    expect(result.code).toBe("NO_PATH");
    expect(result.recoverable).toBe(true);
    expect(result.details).toEqual({ target: "base" });
  });
});
