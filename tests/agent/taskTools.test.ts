import { describe, expect, it, vi } from "vitest";
import {
  createGetTaskPlanTool,
  createManageTaskPlanTool,
  createTaskPlanTool,
} from "../../src/agent/taskTools.js";
import { TaskPlanAuthorizationError } from "../../src/tasks/engine.js";

const taskActor = {
  username: "miner",
  role: "operator" as const,
  source: "minecraft-chat" as const,
};
const taskActorProvider = () => taskActor;

describe("task tools", () => {
  it("creates plans through the engine", async () => {
    const engine = {
      create: vi.fn().mockReturnValue({
        id: 9, title: "mine", steps: [{ id: 1 }],
      }),
    } as any;
    const tool = createTaskPlanTool(engine, taskActorProvider);
    const result = await tool.handler({
      title: "mine",
      steps: [{ skill: "mineUntil", params: { block: "iron_ore" }, maxAttempts: 3 }],
    });
    expect(result.ok).toBe(true);
    expect(result.summary).toContain("task plan 9");
    expect(engine.create).toHaveBeenCalledWith(expect.objectContaining({
      actor: taskActor,
    }));
  });

  it("returns PERMISSION_DENIED for the exact first unauthorized task step", async () => {
    const engine = {
      create: vi.fn(() => {
        throw new TaskPlanAuthorizationError({
          username: "miner",
          actorRole: "operator",
          currentRole: "operator",
          source: "minecraft-chat",
          stepIndex: 1,
          skill: "ownerOnly",
          minimumRole: "owner",
          effect: "administrative",
        });
      }),
    } as any;
    const result = await createTaskPlanTool(engine, taskActorProvider).handler({
      title: "mixed privilege",
      steps: [
        { skill: "mineUntil", params: {}, maxAttempts: 3 },
        { skill: "ownerOnly", params: {}, maxAttempts: 3 },
      ],
    });

    expect(result).toMatchObject({
      ok: false,
      code: "PERMISSION_DENIED",
      details: { stepIndex: 1, skill: "ownerOnly", minimumRole: "owner" },
    });
  });

  it("returns structured plan status", async () => {
    const engine = {
      get: vi.fn().mockReturnValue({
        id: 3, title: "x", status: "running", lastError: null,
        steps: [{
          position: 0, skill: "demo", status: "running",
          attempts: 1, maxAttempts: 3, lastErrorCode: null, lastError: null,
        }],
      }),
    } as any;
    const result = await createGetTaskPlanTool(engine).handler({ planId: 3 });
    expect(result.summary).toContain('"status":"running"');
    expect(result.summary).toContain('"skill":"demo"');
  });

  it("manages plan lifecycle", async () => {
    const engine = {
      pause: vi.fn().mockReturnValue(true),
      resume: vi.fn(), cancel: vi.fn(),
    } as any;
    const result = await createManageTaskPlanTool(engine).handler({
      planId: 2, action: "pause",
    });
    expect(result.ok).toBe(true);
    expect(engine.pause).toHaveBeenCalledWith(2);
  });
});
