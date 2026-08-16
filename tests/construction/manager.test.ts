import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createBus } from "../../src/bus/index.js";
import { createConstructionManager } from "../../src/construction/manager.js";
import {
  createConstructionJob,
  markConstructionPlan,
  registerCompiledBlueprint,
  setConstructionStatus,
} from "../../src/construction/store.js";
import { openDatabase, type DB } from "../../src/memory/db.js";
import { setPlayerRole } from "../../src/permissions/roles.js";
import { cancelTaskPlan, createTaskPlan, getTaskPlan } from "../../src/tasks/store.js";
import { createLogger } from "../../src/util/logger.js";

let tmp: string;
let db: DB;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "smbmc-"));
  db = openDatabase(join(tmp, "memory.sqlite"));
});
afterEach(() => {
  db.close();
  rmSync(tmp, { recursive: true, force: true });
});

function sourceRuntimeVersions(input: {
  configuredVersion?: string;
  liveVersion?: string | undefined;
} = {}) {
  return {
    configuredVersion: input.configuredVersion ?? "1.21.11",
    getLiveVersion: () => input.liveVersion ?? "1.21.11",
  };
}

describe("construction manager", () => {
  it("reauthorizes an owner-required source at start instead of trusting the actor snapshot", () => {
    setPlayerRole(db, {
      username: "Builder",
      role: "operator",
      grantedBy: "Owner",
    });
    registerCompiledBlueprint(db, {
      name: "owner-only-source",
      blocks: [{ x: 0, y: 0, z: 0, block: "tnt" }],
      sourceSchema: "smartbot.build/v1",
      targetVersion: "1.21.11",
      sourceJson: '{"schema":"smartbot.build/v1"}',
      sourceHash: "a".repeat(64),
      compileReportJson: '{"requiredAccess":"owner"}',
      // This provenance is intentionally unrelated to the actor starting it.
      creator: { username: "Owner", role: "owner", source: "desktop" },
    });
    const tasks = {
      create: vi.fn(), get: vi.fn(),
      pause: vi.fn(), resume: vi.fn(), cancel: vi.fn(),
    } as any;
    const manager = createConstructionManager({
      db, bus: createBus(), tasks, log: createLogger({ level: "error" }), ownerUsername: "Owner", now: () => 1_000,
      ...sourceRuntimeVersions(),
    });

    expect(() => manager.startBuild({
      blueprintName: "owner-only-source",
      originX: 0, originY: 64, originZ: 0,
      // An untrusted persisted/request value claims owner, but the live roles
      // table says operator. The manager must use the latter.
      actor: { username: "Builder", role: "owner", source: "minecraft-chat" },
    })).toThrow(/requires owner access; actor 'Builder' currently has operator/);
    expect(tasks.create).not.toHaveBeenCalled();
    expect(db.prepare("SELECT COUNT(*) AS count FROM construction_jobs").get()).toEqual({ count: 0 });
  });

  it("fails closed when a source-backed blueprint lacks a valid access report", () => {
    registerCompiledBlueprint(db, {
      name: "malformed-source-report",
      blocks: [{ x: 0, y: 0, z: 0, block: "stone" }],
      sourceSchema: "smartbot.build/v1",
      targetVersion: "1.21.11",
      sourceJson: '{"schema":"smartbot.build/v1"}',
      sourceHash: "b".repeat(64),
      compileReportJson: '{"placementCount":1}',
      creator: { username: "Owner", role: "owner", source: "desktop" },
    });
    const tasks = {
      create: vi.fn(), get: vi.fn(),
      pause: vi.fn(), resume: vi.fn(), cancel: vi.fn(),
    } as any;
    const manager = createConstructionManager({
      db, bus: createBus(), tasks, log: createLogger({ level: "error" }), ownerUsername: "Owner", now: () => 1_000,
      ...sourceRuntimeVersions(),
    });

    expect(() => manager.startBuild({
      blueprintName: "malformed-source-report",
      originX: 0, originY: 64, originZ: 0,
      actor: { username: "Owner", role: "owner", source: "desktop" },
    })).toThrow(/invalid source access report/);
    expect(tasks.create).not.toHaveBeenCalled();
  });

  it.each([
    {
      label: "configured profile",
      versions: sourceRuntimeVersions({ configuredVersion: "1.21.10", liveVersion: "1.21.11" }),
      message: /targets Minecraft 1\.21\.11, but configured runtime is 1\.21\.10/,
    },
    {
      label: "live client",
      versions: sourceRuntimeVersions({ configuredVersion: "1.21.11", liveVersion: "1.21.10" }),
      message: /targets Minecraft 1\.21\.11, but live bot is 1\.21\.10/,
    },
  ])("rejects a %s version mismatch before source-backed start creates a task plan", ({ versions, message }) => {
    setPlayerRole(db, { username: "Builder", role: "operator", grantedBy: "Owner" });
    registerCompiledBlueprint(db, {
      name: "version-locked-start",
      blocks: [{ x: 0, y: 0, z: 0, block: "stone" }],
      sourceSchema: "smartbot.build/v1",
      targetVersion: "1.21.11",
      sourceJson: '{"schema":"smartbot.build/v1"}',
      sourceHash: "d".repeat(64),
      compileReportJson: '{"requiredAccess":"operator"}',
      creator: { username: "Owner", role: "owner", source: "desktop" },
    });
    const tasks = {
      create: vi.fn(), get: vi.fn(), pause: vi.fn(), resume: vi.fn(), cancel: vi.fn(),
    } as any;
    const manager = createConstructionManager({
      db, bus: createBus(), tasks, log: createLogger({ level: "error" }), ownerUsername: "Owner", now: () => 1_000,
      ...versions,
    });

    expect(() => manager.startBuild({
      blueprintName: "version-locked-start",
      originX: 0, originY: 64, originZ: 0,
      actor: { username: "Builder", role: "operator", source: "minecraft-chat" },
    })).toThrow(message);
    expect(tasks.create).not.toHaveBeenCalled();
    expect(db.prepare("SELECT COUNT(*) AS count FROM construction_jobs").get()).toEqual({ count: 0 });
    expect(db.prepare("SELECT COUNT(*) AS count FROM task_plans").get()).toEqual({ count: 0 });
  });

  it("does not let an operator resume an owner-required source under an older owner plan provenance", () => {
    setPlayerRole(db, {
      username: "Builder",
      role: "operator",
      grantedBy: "Owner",
    });
    const blueprint = registerCompiledBlueprint(db, {
      name: "resume-owner-source",
      blocks: [{ x: 0, y: 0, z: 0, block: "tnt" }],
      sourceSchema: "smartbot.build/v1",
      targetVersion: "1.21.11",
      sourceJson: '{"schema":"smartbot.build/v1"}',
      sourceHash: "c".repeat(64),
      compileReportJson: '{"requiredAccess":"owner"}',
      creator: { username: "Owner", role: "owner", source: "desktop" },
    });
    const job = createConstructionJob(db, {
      blueprintId: blueprint.id,
      originX: 0, originY: 64, originZ: 0,
    }, 1_000);
    const plan = createTaskPlan(db, {
      title: "build resume-owner-source",
      steps: [{ skill: "buildBlueprint", params: { jobId: job.id } }],
      // This is deliberately a real owner plan. An operator who later asks to
      // resume must not inherit this durable provenance.
      actor: { username: "Owner", role: "owner", source: "desktop" },
    });
    markConstructionPlan(db, job.id, plan.id, 1_000);
    setConstructionStatus(db, job.id, "paused", undefined, 1_000);
    const tasks = {
      create: vi.fn(),
      get: vi.fn((id) => getTaskPlan(db, id)),
      pause: vi.fn(), resume: vi.fn().mockReturnValue(true), cancel: vi.fn(),
    } as any;
    const manager = createConstructionManager({
      db, bus: createBus(), tasks, log: createLogger({ level: "error" }), ownerUsername: "Owner", now: () => 2_000,
      ...sourceRuntimeVersions(),
    });

    expect(manager.manageBuild(job.id, "resume", {
      username: "Builder", role: "operator", source: "minecraft-chat",
    })).toBe(false);
    expect(tasks.create).not.toHaveBeenCalled();
    expect(tasks.cancel).not.toHaveBeenCalled();
    expect(tasks.resume).not.toHaveBeenCalled();
    expect(manager.getBuild(job.id)?.status).toBe("paused");
  });

  it("creates a fresh source-backed resume plan under the current authorized requester", () => {
    setPlayerRole(db, { username: "Builder", role: "operator", grantedBy: "Owner" });
    const blueprint = registerCompiledBlueprint(db, {
      name: "operator-source-resume",
      blocks: [{ x: 0, y: 0, z: 0, block: "stone" }],
      sourceSchema: "smartbot.build/v1",
      targetVersion: "1.21.11",
      sourceJson: '{"schema":"smartbot.build/v1"}',
      sourceHash: "e".repeat(64),
      compileReportJson: '{"requiredAccess":"operator"}',
      creator: { username: "Owner", role: "owner", source: "desktop" },
    });
    const job = createConstructionJob(db, {
      blueprintId: blueprint.id,
      originX: 0, originY: 64, originZ: 0,
    }, 1_000);
    const previous = createTaskPlan(db, {
      title: "build operator-source-resume",
      steps: [{ skill: "buildBlueprint", params: { jobId: job.id } }],
      actor: { username: "Owner", role: "owner", source: "desktop" },
    });
    markConstructionPlan(db, job.id, previous.id, 1_000);
    setConstructionStatus(db, job.id, "paused", undefined, 1_000);
    const tasks = {
      create: vi.fn(({ title, steps, actor }) => createTaskPlan(db, { title, steps, actor })),
      get: vi.fn((id) => getTaskPlan(db, id)),
      pause: vi.fn(), resume: vi.fn(), cancel: vi.fn((id) => cancelTaskPlan(db, id)),
    } as any;
    const manager = createConstructionManager({
      db, bus: createBus(), tasks, log: createLogger({ level: "error" }), ownerUsername: "Owner", now: () => 2_000,
      ...sourceRuntimeVersions(),
    });

    const requester = { username: "Builder", role: "operator" as const, source: "minecraft-chat" as const };
    expect(manager.manageBuild(job.id, "resume", requester)).toBe(true);
    const resumed = manager.getBuild(job.id)!;
    expect(resumed).toMatchObject({ status: "running" });
    expect(resumed.lastPlanId).not.toBe(previous.id);
    expect(getTaskPlan(db, previous.id)?.status).toBe("cancelled");
    expect(getTaskPlan(db, resumed.lastPlanId!)?.actor).toEqual(requester);
    expect(tasks.create).toHaveBeenCalledWith(expect.objectContaining({ actor: requester }));
    expect(tasks.resume).not.toHaveBeenCalled();
  });

  it("rejects a live-version mismatch before source-backed resume cancels or creates a task plan", () => {
    setPlayerRole(db, { username: "Builder", role: "operator", grantedBy: "Owner" });
    const blueprint = registerCompiledBlueprint(db, {
      name: "version-locked-resume",
      blocks: [{ x: 0, y: 0, z: 0, block: "stone" }],
      sourceSchema: "smartbot.build/v1",
      targetVersion: "1.21.11",
      sourceJson: '{"schema":"smartbot.build/v1"}',
      sourceHash: "f".repeat(64),
      compileReportJson: '{"requiredAccess":"operator"}',
      creator: { username: "Owner", role: "owner", source: "desktop" },
    });
    const job = createConstructionJob(db, {
      blueprintId: blueprint.id,
      originX: 0, originY: 64, originZ: 0,
    }, 1_000);
    const previous = createTaskPlan(db, {
      title: "build version-locked-resume",
      steps: [{ skill: "buildBlueprint", params: { jobId: job.id } }],
      actor: { username: "Owner", role: "owner", source: "desktop" },
    });
    markConstructionPlan(db, job.id, previous.id, 1_000);
    setConstructionStatus(db, job.id, "paused", undefined, 1_000);
    const tasks = {
      create: vi.fn(), get: vi.fn((id) => getTaskPlan(db, id)),
      pause: vi.fn(), resume: vi.fn(), cancel: vi.fn(),
    } as any;
    const manager = createConstructionManager({
      db, bus: createBus(), tasks, log: createLogger({ level: "error" }), ownerUsername: "Owner", now: () => 2_000,
      ...sourceRuntimeVersions({ configuredVersion: "1.21.11", liveVersion: "1.21.10" }),
    });

    expect(manager.manageBuild(job.id, "resume", {
      username: "Builder", role: "operator", source: "minecraft-chat",
    })).toBe(false);
    expect(tasks.create).not.toHaveBeenCalled();
    expect(tasks.cancel).not.toHaveBeenCalled();
    expect(tasks.resume).not.toHaveBeenCalled();
    expect(manager.getBuild(job.id)).toMatchObject({ status: "paused", lastPlanId: previous.id });
    expect(db.prepare("SELECT COUNT(*) AS count FROM task_plans").get()).toEqual({ count: 1 });
  });

  it("keeps legacy source-free blueprints startable through their existing path", () => {
    const tasks = {
      create: vi.fn(({ title, steps, actor }) => createTaskPlan(db, { title, steps, actor })),
      get: vi.fn((id) => getTaskPlan(db, id)),
      pause: vi.fn().mockReturnValue(false),
      resume: vi.fn().mockReturnValue(false),
      cancel: vi.fn().mockReturnValue(false),
    } as any;
    const getLiveVersion = vi.fn(() => undefined);
    const manager = createConstructionManager({
      db, bus: createBus(), tasks, log: createLogger({ level: "error" }), ownerUsername: "Owner", now: () => 1_000,
      configuredVersion: "1.21.11",
      getLiveVersion,
    });
    manager.registerBlueprint({
      name: "legacy-raw",
      blocks: [{ x: 0, y: 0, z: 0, block: "stone" }],
    });

    const job = manager.startBuild({
      blueprintName: "legacy-raw",
      originX: 0, originY: 64, originZ: 0,
      actor: { username: "Builder", role: "operator", source: "minecraft-chat" },
    });
    expect(job.blueprintName).toBe("legacy-raw");
    expect(tasks.create).toHaveBeenCalledOnce();
    expect(getLiveVersion).not.toHaveBeenCalled();
  });

  it("materializes two pending builds into one existing plan without creating a nested plan", () => {
    const actor = {
      username: "builder",
      role: "operator" as const,
      source: "minecraft-chat" as const,
    };
    const tasks = {
      create: vi.fn(), get: vi.fn(),
      pause: vi.fn(), resume: vi.fn(), cancel: vi.fn(),
    } as any;
    const manager = createConstructionManager({
      db, bus: createBus(), tasks, log: createLogger({ level: "error" }), ownerUsername: "owner", now: () => 1_000,
      ...sourceRuntimeVersions(),
    });
    const firstBlueprint = manager.registerBlueprint({
      name: "mission-first",
      blocks: [{ x: 0, y: 0, z: 0, block: "stone" }],
    });
    const secondBlueprint = manager.registerBlueprint({
      name: "mission-second",
      blocks: [{ x: 0, y: 0, z: 0, block: "dirt" }],
    });

    const first = manager.createPendingBuild({
      blueprintName: firstBlueprint.name,
      originX: 0, originY: 64, originZ: 0,
      actor,
    });
    const second = manager.createPendingBuild({
      blueprintId: secondBlueprint.id,
      originX: 8, originY: 64, originZ: 0,
      actor,
    });
    const missionPlan = createTaskPlan(db, {
      title: "mission one plan, two builds",
      steps: [
        { skill: "prepareBlueprintMaterials", params: { jobId: first.id } },
        { skill: "buildBlueprint", params: { jobId: first.id } },
        { skill: "prepareBlueprintMaterials", params: { jobId: second.id } },
        { skill: "buildBlueprint", params: { jobId: second.id } },
      ],
      actor,
    });

    expect(manager.linkPendingBuildsToPlan([first.id, second.id], missionPlan.id)
      .map((job) => [job.id, job.lastPlanId, job.status]))
      .toEqual([
        [first.id, missionPlan.id, "running"],
        [second.id, missionPlan.id, "running"],
      ]);
    expect(manager.getBuildsByPlan(missionPlan.id).map((job) => job.id)).toEqual([first.id, second.id]);
    expect(tasks.create).not.toHaveBeenCalled();

    expect(manager.pauseBuildsByPlan(missionPlan.id).map((job) => job.status))
      .toEqual(["paused", "paused"]);
    expect(manager.resumeBuildsByPlan(missionPlan.id).map((job) => job.status))
      .toEqual(["running", "running"]);
    expect(manager.cancelBuildsByPlan(missionPlan.id).map((job) => job.status))
      .toEqual(["cancelled", "cancelled"]);
    // These are job-only primitives. MissionService controls the single task
    // plan itself, so no fresh construction plan can appear on resume.
    expect(tasks.create).not.toHaveBeenCalled();
    expect(tasks.pause).not.toHaveBeenCalled();
    expect(tasks.resume).not.toHaveBeenCalled();
    expect(tasks.cancel).not.toHaveBeenCalled();
  });

  it("applies task completion/failure protection to every build linked to a shared plan", () => {
    const actor = {
      username: "builder",
      role: "operator" as const,
      source: "minecraft-chat" as const,
    };
    const bus = createBus();
    const tasks = {
      create: vi.fn(), get: vi.fn(),
      pause: vi.fn(), resume: vi.fn(), cancel: vi.fn(),
    } as any;
    const manager = createConstructionManager({
      db, bus, tasks, log: createLogger({ level: "error" }), ownerUsername: "owner", now: () => 1_000,
      ...sourceRuntimeVersions(),
    });
    const blueprint = manager.registerBlueprint({
      name: "shared-plan-marker",
      blocks: [{ x: 0, y: 0, z: 0, block: "stone" }],
    });
    const first = manager.createPendingBuild({
      blueprintName: blueprint.name,
      originX: 0, originY: 64, originZ: 0,
      actor,
    });
    const second = manager.createPendingBuild({
      blueprintName: blueprint.name,
      originX: 8, originY: 64, originZ: 0,
      actor,
    });
    const plan = createTaskPlan(db, {
      title: "shared plan completion guard",
      steps: [{ skill: "buildBlueprint", params: { jobId: first.id } }],
      actor,
    });
    manager.linkPendingBuildsToPlan([first.id, second.id], plan.id);
    manager.start();

    bus.emit("agent.trigger", {
      kind: "taskPlanDone",
      planId: plan.id,
      title: plan.title,
    });

    expect(manager.getBuildsByPlan(plan.id).map((job) => [job.id, job.status, job.lastError]))
      .toEqual([
        [first.id, "failed", "task plan completed without a verified construction completion"],
        [second.id, "failed", "task plan completed without a verified construction completion"],
      ]);
    manager.stop();
  });

  it.each([
    ["pause", "paused"],
    ["cancel", "cancelled"],
  ] as const)("cancels an unlinked plan when a concurrent %s wins", (action, expectedStatus) => {
    const actor = {
      username: "builder",
      role: "operator" as const,
      source: "minecraft-chat" as const,
    };
    let manager!: ReturnType<typeof createConstructionManager>;
    let createdPlanId: number | undefined;
    const tasks = {
      create: vi.fn(({ title, steps, actor: planActor }) => {
        const plan = createTaskPlan(db, { title, steps, actor: planActor });
        createdPlanId = plan.id;
        // This runs after the plan is durable but before schedule() can link
        // it, reproducing the control-plane race without relying on timers.
        expect(manager.manageBuild(job.id, action, actor)).toBe(true);
        return plan;
      }),
      get: vi.fn((id) => getTaskPlan(db, id)),
      pause: vi.fn().mockReturnValue(false),
      resume: vi.fn().mockReturnValue(false),
      cancel: vi.fn((id) => cancelTaskPlan(db, id)),
    } as any;
    manager = createConstructionManager({
      db, bus: createBus(), tasks, log: createLogger({ level: "error" }), ownerUsername: "owner", now: () => 1_000,
      ...sourceRuntimeVersions(),
    });
    const blueprint = manager.registerBlueprint({
      name: `race-${action}`,
      blocks: [{ x: 0, y: 0, z: 0, block: "stone" }],
    });
    const job = createConstructionJob(db, {
      blueprintId: blueprint.id,
      originX: 0, originY: 64, originZ: 0,
    }, 1_000);
    setConstructionStatus(db, job.id, "failed", undefined, 1_000);

    expect(manager.manageBuild(job.id, "resume", actor)).toBe(true);
    expect(createdPlanId).toBeDefined();
    expect(tasks.cancel).toHaveBeenCalledWith(createdPlanId);
    expect(getTaskPlan(db, createdPlanId!)?.status).toBe("cancelled");
    expect(manager.getBuild(job.id)).toMatchObject({
      status: expectedStatus,
      lastPlanId: null,
    });
  });

  it("does not mistake a completed task plan for verified construction completion", () => {
    const actor = {
      username: "builder",
      role: "operator" as const,
      source: "minecraft-chat" as const,
    };
    const bus = createBus();
    const tasks = {
      create: vi.fn(({ title, steps, actor: planActor }) => createTaskPlan(db, { title, steps, actor: planActor })),
      get: vi.fn((id) => getTaskPlan(db, id)),
      pause: vi.fn().mockReturnValue(false),
      resume: vi.fn().mockReturnValue(false),
      cancel: vi.fn().mockReturnValue(false),
    } as any;
    const manager = createConstructionManager({
      db, bus, tasks, log: createLogger({ level: "error" }), ownerUsername: "owner", now: () => 1_000,
      ...sourceRuntimeVersions(),
    });
    manager.start();
    manager.registerBlueprint({
      name: "marker",
      blocks: [{ x: 0, y: 0, z: 0, block: "stone" }],
    });
    const job = manager.startBuild({
      blueprintName: "marker",
      originX: 5, originY: 65, originZ: 7,
      actor,
    });

    bus.emit("agent.trigger", {
      kind: "taskPlanDone",
      planId: job.lastPlanId!,
      title: "build marker",
    });

    expect(manager.getBuild(job.id)).toMatchObject({
      status: "failed",
      lastError: "task plan completed without a verified construction completion",
    });
    manager.stop();
  });

  it("creates durable builds and resumes blocked work with a fresh plan", () => {
    const actor = {
      username: "builder",
      role: "operator" as const,
      source: "minecraft-chat" as const,
    };
    const bus = createBus();
    const tasks = {
      create: vi.fn(({ title, steps, actor }) => createTaskPlan(db, { title, steps, actor })),
      get: vi.fn((id) => getTaskPlan(db, id)),
      pause: vi.fn().mockReturnValue(false),
      resume: vi.fn().mockReturnValue(false),
      cancel: vi.fn().mockReturnValue(false),
    } as any;
    const manager = createConstructionManager({
      db, bus, tasks, log: createLogger({ level: "error" }), ownerUsername: "owner", now: () => 1_000,
      ...sourceRuntimeVersions(),
    });
    manager.start();
    manager.registerBlueprint({
      name: "marker",
      blocks: [{ x: 0, y: 0, z: 0, block: "stone" }],
    });
    const job = manager.startBuild({
      blueprintName: "marker",
      originX: 5, originY: 65, originZ: 7,
      actor,
    });
    const duplicate = manager.startBuild({
      blueprintName: "marker",
      originX: 5, originY: 65, originZ: 7,
      actor,
    });
    expect(duplicate.id).toBe(job.id);
    expect(tasks.create).toHaveBeenCalledTimes(1);
    expect(tasks.create).toHaveBeenCalledWith({
      title: "build marker at 5,65,7",
      steps: [
        {
          skill: "prepareBlueprintMaterials",
          params: { jobId: job.id },
          maxAttempts: 2,
        },
        {
          skill: "buildBlueprint",
          params: { jobId: job.id },
          maxAttempts: 3,
        },
      ],
      actor,
    });
    const firstPlan = job.lastPlanId;
    expect(manager.pauseByPlan(firstPlan!)).toMatchObject({
      id: job.id,
      status: "paused",
    });
    expect(manager.manageBuild(job.id, "resume", actor)).toBe(true);
    expect(manager.getBuild(job.id)?.status).toBe("running");
    setConstructionStatus(db, job.id, "blocked", "needs stone");
    bus.emit("agent.trigger", {
      kind: "taskPlanFailed",
      planId: firstPlan!,
      title: "build marker",
      error: "needs stone",
    });
    expect(manager.getBuild(job.id)?.status).toBe("blocked");
    expect(manager.manageBuild(job.id, "resume", actor)).toBe(true);
    expect(manager.getBuild(job.id)).toMatchObject({
      status: "running",
      lastError: null,
    });
    expect(manager.getBuild(job.id)?.lastPlanId).not.toBe(firstPlan);
    manager.stop();
  });
});
