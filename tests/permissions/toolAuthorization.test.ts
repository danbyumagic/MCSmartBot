import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { createCapabilityPolicy } from "../../src/permissions/capabilities.js";
import { createSkillTool } from "../../src/agent/skillTools.js";
import { tossItem } from "../../src/skills/items/tossItem.js";
import { createClearRegionSkill } from "../../src/skills/world/clearRegion.js";
import { attackPlayer } from "../../src/skills/combat/attackPlayer.js";
import { attackMob } from "../../src/skills/combat/attackMob.js";
import { clickWindowSlot } from "../../src/skills/interaction/clickWindowSlot.js";
import { inspectWindow } from "../../src/skills/interaction/inspectWindow.js";
import {
  authorizeTool,
  canUseTool,
} from "../../src/permissions/toolAuthorization.js";

const viewerRead = createCapabilityPolicy({
  minimumRole: "viewer",
  effect: "read",
  reversible: false,
  mission: "forbidden",
});
const operatorWorldChange = createCapabilityPolicy({
  minimumRole: "operator",
  effect: "world-change",
  reversible: false,
  mission: "public",
});
const ownerAdministrative = createCapabilityPolicy({
  minimumRole: "owner",
  effect: "administrative",
  reversible: false,
  mission: "forbidden",
});

describe("role-based tool authorization", () => {
  it("uses policy rank rather than a tool-name allow or deny list", () => {
    expect(canUseTool("viewer", viewerRead)).toBe(true);
    expect(canUseTool("viewer", operatorWorldChange)).toBe(false);
    expect(canUseTool("operator", operatorWorldChange)).toBe(true);
    expect(canUseTool("operator", ownerAdministrative)).toBe(false);
    expect(canUseTool("owner", ownerAdministrative)).toBe(true);
  });

  it("denies before invoking the handler and reports the required capability", async () => {
    const handler = vi.fn().mockResolvedValue({ ok: true, summary: "ran" });
    const actor = { username: "bob", role: "viewer" as const };
    const tool = authorizeTool({
      name: "arbitrarilyNamedTool",
      description: "mutation",
      policy: operatorWorldChange,
      inputSchema: z.object({}),
      handler,
    }, actor);
    const denied = await tool.handler({});
    expect(denied).toMatchObject({
      ok: false,
      code: "PERMISSION_DENIED",
      details: {
        username: "bob",
        role: "viewer",
        tool: "arbitrarilyNamedTool",
        minimumRole: "operator",
        effect: "world-change",
      },
    });
    expect(handler).not.toHaveBeenCalled();
  });

  it("clones and freezes policy during registration", async () => {
    const handler = vi.fn().mockResolvedValue({ ok: true, summary: "ran" });
    const actor = { username: "bob", role: "viewer" as const };
    const inputPolicy = {
      minimumRole: "operator" as const,
      effect: "world-change" as const,
      reversible: false,
      mission: "public" as const,
    };
    const tool = authorizeTool({
      name: "mutableFixture",
      description: "mutation",
      policy: inputPolicy,
      inputSchema: z.object({}),
      handler,
    }, actor);

    expect(tool.policy).not.toBe(inputPolicy);
    expect(Object.isFrozen(tool.policy)).toBe(true);
    expect(tool.policy.minimumRole).toBe("operator");
    expect(await tool.handler({})).toMatchObject({ code: "PERMISSION_DENIED" });
  });

  it("denies an operator direct access to real owner-only destructive skills", async () => {
    const runner = { run: vi.fn() } as never;
    const operator = { username: "builder", role: "operator" as const, source: "minecraft-chat" as const };
    const clearRegion = createClearRegionSkill({ transactions: {} as never, serverKey: "test:25565" });
    const tools = [
      authorizeTool(createSkillTool(clearRegion, runner, () => operator), operator),
      authorizeTool(createSkillTool(tossItem, runner, () => operator), operator),
      authorizeTool(createSkillTool(attackPlayer, runner, () => operator), operator),
      authorizeTool(createSkillTool(clickWindowSlot, runner, () => operator), operator),
    ];

    const [clearDenied, tossDenied, attackDenied, clickDenied] = await Promise.all([
      tools[0]!.handler({
        from: { x: 0, y: 64, z: 0 }, to: { x: 0, y: 64, z: 0 },
        includeContainers: false, preserve: [], collectDrops: false,
      }),
      tools[1]!.handler({ item: "stone", count: 1 }),
      tools[2]!.handler({ selector: { username: "Target" }, mode: "once", maxHits: 1, maxSeconds: 1, maxRange: 2 }),
      tools[3]!.handler({ slot: 0, mouseButton: 0, mode: "click" }),
    ]);

    expect(clearDenied).toMatchObject({
      ok: false, code: "PERMISSION_DENIED", details: { tool: "clearRegion", minimumRole: "owner" },
    });
    expect(tossDenied).toMatchObject({
      ok: false, code: "PERMISSION_DENIED", details: { tool: "tossItem", minimumRole: "owner" },
    });
    expect(attackDenied).toMatchObject({
      ok: false, code: "PERMISSION_DENIED", details: { tool: "attackPlayer", minimumRole: "owner" },
    });
    expect(clickDenied).toMatchObject({
      ok: false, code: "PERMISSION_DENIED", details: { tool: "clickWindowSlot", minimumRole: "owner" },
    });
    expect((runner as any).run).not.toHaveBeenCalled();
  });

  it("denies viewers but permits operators to invoke real Task 7 operator skills", async () => {
    const runner = { run: vi.fn().mockResolvedValue({ ok: true, summary: "ran" }) } as never;
    const viewer = { username: "spectator", role: "viewer" as const, source: "minecraft-chat" as const };
    const operator = { username: "builder", role: "operator" as const, source: "minecraft-chat" as const };
    const viewerAttack = authorizeTool(createSkillTool(attackMob, runner, () => viewer), viewer);
    const viewerInspect = authorizeTool(createSkillTool(inspectWindow, runner, () => viewer), viewer);
    const operatorAttack = authorizeTool(createSkillTool(attackMob, runner, () => operator), operator);

    await expect(viewerAttack.handler({ selector: { entityId: 7 } })).resolves.toMatchObject({
      ok: false, code: "PERMISSION_DENIED", details: { tool: "attackMob", minimumRole: "operator" },
    });
    await expect(viewerInspect.handler({})).resolves.toMatchObject({
      ok: false, code: "PERMISSION_DENIED", details: { tool: "inspectWindow", minimumRole: "operator" },
    });
    await expect(operatorAttack.handler({ selector: { entityId: 7 } })).resolves.toMatchObject({
      ok: true, summary: "ran",
    });
    expect((runner as any).run).toHaveBeenCalledTimes(1);
  });
});
