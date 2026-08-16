import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDatabase, type DB } from "../../src/memory/db.js";
import {
  createConstructionJob,
  countExpectedWorldCells,
  countPlacementUnitMaterials,
  getBlueprintSource,
  getBlueprintByName,
  getConstructionJob,
  listConstructionJobsByPlan,
  linkPendingConstructionJobsToPlan,
  listBlueprints,
  markConstructionPlan,
  registerCompiledBlueprint,
  normalizeBlueprintPlacementUnits,
  setConstructionStatus,
  setConstructionJobsStatusByPlan,
  setConstructionStatusIfCurrent,
  updateConstructionProgress,
  updateConstructionProgressIfCurrent,
  upsertBlueprint,
} from "../../src/construction/store.js";
import { createTaskPlan } from "../../src/tasks/store.js";
import { systemActor } from "../../src/permissions/executionActor.js";

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

describe("construction store", () => {
  it("normalizes and sorts blueprint blocks", () => {
    const blueprint = upsertBlueprint(db, {
      name: "hut",
      blocks: [
        { x: 1, y: 1, z: 0, block: " Oak_Planks " },
        { x: 0, y: 0, z: 0, block: "cobblestone" },
      ],
    }, 100);
    expect(blueprint.blocks).toEqual([
      { x: 0, y: 0, z: 0, block: "cobblestone" },
      { x: 1, y: 1, z: 0, block: "oak_planks" },
    ]);
    expect(getBlueprintByName(db, "hut")?.id).toBe(blueprint.id);
    expect(blueprint.placementUnits).toEqual([
      {
        anchor: { x: 0, y: 0, z: 0, block: "cobblestone" },
        item: "cobblestone",
        expectedCells: [{ x: 0, y: 0, z: 0, block: "cobblestone" }],
      },
      {
        anchor: { x: 1, y: 1, z: 0, block: "oak_planks" },
        item: "oak_planks",
        expectedCells: [{ x: 1, y: 1, z: 0, block: "oak_planks" }],
      },
    ]);
  });

  it("normalizes legacy cells into single-item units without changing their flat storage shape", () => {
    const cells = [
      { x: 0, y: 0, z: 0, block: "stone" },
      { x: 1, y: 0, z: 0, block: "stone" },
      { x: 2, y: 0, z: 0, block: "dirt" },
    ];
    const units = normalizeBlueprintPlacementUnits(cells);

    expect(units).toHaveLength(3);
    expect(countPlacementUnitMaterials(units)).toEqual(new Map([["stone", 2], ["dirt", 1]]));
    expect(countExpectedWorldCells(units)).toBe(3);

    const blueprint = upsertBlueprint(db, { name: "legacy-units", blocks: cells });
    const raw = db.prepare("SELECT blocks_json FROM blueprints WHERE id = ?").get(blueprint.id) as {
      blocks_json: string;
    };
    expect(JSON.parse(raw.blocks_json)).toEqual(blueprint.blocks);
    expect(blueprint.placementUnits).toHaveLength(blueprint.blocks.length);
  });

  it("persists compiler-vetted one-cell stair hints and restores them after restart", () => {
    const compiled = registerCompiledBlueprint(db, {
      name: "hinted-stairs",
      blocks: [{
        x: 0, y: 0, z: 0, block: "oak_stairs",
        hint: { facing: "east", half: "top" },
      }],
      sourceSchema: "smartbot.build/v1",
      targetVersion: "1.21.11",
      sourceJson: "{}",
      sourceHash: "1".repeat(64),
      compileReportJson: "{}",
      creator: systemActor("owner", "recovery"),
    });

    expect(compiled.blocks).toEqual([{
      x: 0, y: 0, z: 0, block: "oak_stairs",
      hint: { facing: "east", half: "top" },
    }]);
    expect(compiled.placementUnits).toEqual([expect.objectContaining({
      item: "oak_stairs",
      hint: { facing: "east", half: "top" },
    })]);

    db.close();
    db = openDatabase(join(tmp, "memory.sqlite"));
    expect(getBlueprintByName(db, "hinted-stairs")?.placementUnits).toEqual([
      expect.objectContaining({ hint: { facing: "east", half: "top" } }),
    ]);
  });

  it("keeps raw blueprints compatible but refuses raw state hints", () => {
    expect(upsertBlueprint(db, {
      name: "ordinary-raw",
      blocks: [{ x: 0, y: 0, z: 0, block: "stone" }],
    }).blocks).toEqual([{ x: 0, y: 0, z: 0, block: "stone" }]);

    expect(() => upsertBlueprint(db, {
      name: "raw-hinted",
      blocks: [{
        x: 0, y: 0, z: 0, block: "oak_stairs",
        hint: { facing: "north", half: "bottom" },
      }],
    })).toThrow(/raw blueprints cannot include placement hints/);
  });

  it("fails closed when compiled or persisted hint data is malformed", () => {
    expect(() => registerCompiledBlueprint(db, {
      name: "invalid-write-hint",
      blocks: [{
        x: 0, y: 0, z: 0, block: "oak_stairs",
        hint: { facing: "up" } as never,
      }],
      sourceSchema: "smartbot.build/v1",
      targetVersion: "1.21.11",
      sourceJson: "{}",
      sourceHash: "0".repeat(64),
      compileReportJson: "{}",
      creator: systemActor("owner", "recovery"),
    })).toThrow(/placement hint facing/);

    const compiled = registerCompiledBlueprint(db, {
      name: "corrupt-hint",
      blocks: [{ x: 0, y: 0, z: 0, block: "stone" }],
      sourceSchema: "smartbot.build/v1",
      targetVersion: "1.21.11",
      sourceJson: "{}",
      sourceHash: "2".repeat(64),
      compileReportJson: "{}",
      creator: systemActor("owner", "recovery"),
    });
    db.prepare("UPDATE blueprints SET blocks_json = ? WHERE id = ?").run(
      JSON.stringify([{
        x: 0, y: 0, z: 0, block: "oak_stairs",
        hint: { facing: "up", half: "bottom" },
      }]),
      compiled.id,
    );

    expect(() => getBlueprintByName(db, "corrupt-hint")).toThrow(/placement hint facing/);
  });

  it("rejects duplicate coordinates", () => {
    expect(() => upsertBlueprint(db, {
      name: "bad",
      blocks: [
        { x: 0, y: 0, z: 0, block: "stone" },
        { x: 0, y: 0, z: 0, block: "dirt" },
      ],
    })).toThrow(/duplicate blueprint coordinate/);
  });

  it("lists saved blueprints by name", () => {
    upsertBlueprint(db, {
      name: "z_wall",
      blocks: [{ x: 0, y: 0, z: 0, block: "stone" }],
    });
    upsertBlueprint(db, {
      name: "a_platform",
      blocks: [{ x: 0, y: 0, z: 0, block: "dirt" }],
    });
    expect(listBlueprints(db).map((blueprint) => blueprint.name)).toEqual([
      "a_platform",
      "z_wall",
    ]);
  });

  it("persists job plans, progress, and lifecycle state", () => {
    const blueprint = upsertBlueprint(db, {
      name: "path",
      blocks: [{ x: 0, y: 0, z: 0, block: "stone" }],
    });
    const job = createConstructionJob(db, {
      blueprintId: blueprint.id,
      originX: 10, originY: 64, originZ: 20,
      storageName: "main",
      rotation: 90,
    }, 200);
    const plan = createTaskPlan(db, {
      title: "build path",
      steps: [{ skill: "buildBlueprint", params: { jobId: job.id } }],
      actor: systemActor("owner", "recovery"),
    });
    markConstructionPlan(db, job.id, plan.id, 300);
    updateConstructionProgress(db, job.id, 1, 400);
    setConstructionStatus(db, job.id, "completed", undefined, 500);
    expect(getConstructionJob(db, job.id)).toMatchObject({
      blueprintName: "path",
      storageName: "main",
      rotation: 90,
      placedCount: 1,
      totalCount: 1,
      lastPlanId: plan.id,
      status: "completed",
    });
  });

  it("atomically links multiple pending jobs to one plan and keeps plan lifecycle writes scoped", () => {
    const blueprint = upsertBlueprint(db, {
      name: "mission-plural-build",
      blocks: [{ x: 0, y: 0, z: 0, block: "stone" }],
    });
    const first = createConstructionJob(db, {
      blueprintId: blueprint.id, originX: 0, originY: 64, originZ: 0,
    }, 100);
    const second = createConstructionJob(db, {
      blueprintId: blueprint.id, originX: 8, originY: 64, originZ: 0,
    }, 100);
    const plan = createTaskPlan(db, {
      title: "two mission builds",
      steps: [
        { skill: "buildBlueprint", params: { jobId: first.id } },
        { skill: "buildBlueprint", params: { jobId: second.id } },
      ],
      actor: systemActor("owner", "recovery"),
    });

    // The return order follows the caller so a materializer can retain its
    // logical-step mapping; durable plan reads are deterministic by job ID.
    expect(linkPendingConstructionJobsToPlan(db, [second.id, first.id], plan.id, 200)
      .map((job) => [job.id, job.status, job.lastPlanId]))
      .toEqual([
        [second.id, "running", plan.id],
        [first.id, "running", plan.id],
      ]);
    expect(listConstructionJobsByPlan(db, plan.id).map((job) => job.id)).toEqual([first.id, second.id]);

    expect(setConstructionJobsStatusByPlan(db, plan.id, "paused", undefined, 201)
      .map((job) => job.status)).toEqual(["paused", "paused"]);
    expect(setConstructionJobsStatusByPlan(db, plan.id, "running", undefined, 202)
      .map((job) => job.status)).toEqual(["running", "running"]);
    expect(setConstructionJobsStatusByPlan(db, plan.id, "cancelled", undefined, 203)
      .map((job) => job.status)).toEqual(["cancelled", "cancelled"]);
    // A stale resume cannot revive a terminal build linked to this plan.
    expect(setConstructionJobsStatusByPlan(db, plan.id, "running", undefined, 204)
      .map((job) => job.status)).toEqual(["cancelled", "cancelled"]);
  });

  it("rolls back a plural plan link when any supplied job is no longer pending and unlinked", () => {
    const blueprint = upsertBlueprint(db, {
      name: "mission-plural-link-race",
      blocks: [{ x: 0, y: 0, z: 0, block: "stone" }],
    });
    const first = createConstructionJob(db, {
      blueprintId: blueprint.id, originX: 0, originY: 64, originZ: 0,
    }, 100);
    const raced = createConstructionJob(db, {
      blueprintId: blueprint.id, originX: 8, originY: 64, originZ: 0,
    }, 100);
    expect(setConstructionStatus(db, raced.id, "paused", undefined, 101)).toBe(true);
    const plan = createTaskPlan(db, {
      title: "failed plural link",
      steps: [{ skill: "buildBlueprint", params: { jobId: first.id } }],
      actor: systemActor("owner", "recovery"),
    });

    expect(() => linkPendingConstructionJobsToPlan(db, [first.id, raced.id], plan.id, 200))
      .toThrow(/pending and unlinked/);
    expect(getConstructionJob(db, first.id)).toMatchObject({ status: "pending", lastPlanId: null });
    expect(getConstructionJob(db, raced.id)).toMatchObject({ status: "paused", lastPlanId: null });
    expect(listConstructionJobsByPlan(db, plan.id)).toEqual([]);
  });

  it("does not let stale execution writes revive or complete paused/cancelled jobs", () => {
    const blueprint = upsertBlueprint(db, {
      name: "conditional-status",
      blocks: [{ x: 0, y: 0, z: 0, block: "stone" }],
    });
    const pausedJob = createConstructionJob(db, {
      blueprintId: blueprint.id, originX: 0, originY: 64, originZ: 0,
    });
    const firstPlan = createTaskPlan(db, {
      title: "first conditional build",
      steps: [{ skill: "buildBlueprint", params: { jobId: pausedJob.id } }],
      actor: systemActor("owner", "recovery"),
    });
    const replacementPlan = createTaskPlan(db, {
      title: "replacement conditional build",
      steps: [{ skill: "buildBlueprint", params: { jobId: pausedJob.id } }],
      actor: systemActor("owner", "recovery"),
    });

    expect(markConstructionPlan(db, pausedJob.id, firstPlan.id, 100)).toBe(true);
    expect(setConstructionStatus(db, pausedJob.id, "paused", undefined, 101)).toBe(true);
    expect(markConstructionPlan(db, pausedJob.id, replacementPlan.id, 102)).toBe(false);
    expect(updateConstructionProgress(db, pausedJob.id, 1, 103)).toBe(false);
    expect(setConstructionStatus(db, pausedJob.id, "completed", undefined, 104)).toBe(false);
    expect(setConstructionStatusIfCurrent(db, {
      jobId: pausedJob.id,
      status: "completed",
      expectedStatuses: ["running"],
      expectedPlanId: firstPlan.id,
    }, 105)).toBe(false);
    expect(updateConstructionProgressIfCurrent(db, {
      jobId: pausedJob.id,
      placedCount: 1,
      expectedStatuses: ["running"],
      expectedPlanId: firstPlan.id,
    }, 106)).toBe(false);
    expect(getConstructionJob(db, pausedJob.id)).toMatchObject({
      status: "paused",
      placedCount: 0,
      lastPlanId: firstPlan.id,
    });

    // An explicit controller resume is still legal. The stale first plan still
    // cannot write because the plan identity participates in the guard.
    expect(setConstructionStatus(db, pausedJob.id, "running", undefined, 107)).toBe(true);
    expect(setConstructionStatusIfCurrent(db, {
      jobId: pausedJob.id,
      status: "completed",
      expectedStatuses: ["running"],
      expectedPlanId: replacementPlan.id,
    }, 108)).toBe(false);
    expect(getConstructionJob(db, pausedJob.id)?.status).toBe("running");

    const cancelledJob = createConstructionJob(db, {
      blueprintId: blueprint.id, originX: 10, originY: 64, originZ: 0,
    });
    const cancelledPlan = createTaskPlan(db, {
      title: "cancelled conditional build",
      steps: [{ skill: "buildBlueprint", params: { jobId: cancelledJob.id } }],
      actor: systemActor("owner", "recovery"),
    });
    expect(markConstructionPlan(db, cancelledJob.id, cancelledPlan.id, 110)).toBe(true);
    expect(setConstructionStatus(db, cancelledJob.id, "cancelled", undefined, 111)).toBe(true);
    expect(markConstructionPlan(db, cancelledJob.id, replacementPlan.id, 112)).toBe(false);
    expect(setConstructionStatus(db, cancelledJob.id, "running", undefined, 113)).toBe(false);
    expect(setConstructionStatus(db, cancelledJob.id, "completed", undefined, 114)).toBe(false);
    expect(updateConstructionProgress(db, cancelledJob.id, 1, 115)).toBe(false);
    expect(getConstructionJob(db, cancelledJob.id)).toMatchObject({
      status: "cancelled",
      placedCount: 0,
      lastPlanId: cancelledPlan.id,
    });
  });

  it("guards direct execution writes against a job becoming linked to a task plan", () => {
    const blueprint = upsertBlueprint(db, {
      name: "unlinked-conditional-build",
      blocks: [{ x: 0, y: 0, z: 0, block: "stone" }],
    });
    const job = createConstructionJob(db, {
      blueprintId: blueprint.id, originX: 0, originY: 64, originZ: 0,
    });

    // A direct attempt can update an unlinked pending job.
    expect(updateConstructionProgressIfCurrent(db, {
      jobId: job.id,
      placedCount: 0,
      expectedStatuses: ["pending"],
      expectedNoPlan: true,
    }, 100)).toBe(true);

    const plan = createTaskPlan(db, {
      title: "linked conditional build",
      steps: [{ skill: "buildBlueprint", params: { jobId: job.id } }],
      actor: systemActor("owner", "recovery"),
    });
    expect(markConstructionPlan(db, job.id, plan.id, 101)).toBe(true);

    // The same direct attempt must lose its compare-and-set once the
    // controller owns the job through a plan.
    expect(updateConstructionProgressIfCurrent(db, {
      jobId: job.id,
      placedCount: 1,
      expectedStatuses: ["running"],
      expectedNoPlan: true,
    }, 102)).toBe(false);
    expect(setConstructionStatusIfCurrent(db, {
      jobId: job.id,
      status: "completed",
      expectedStatuses: ["running"],
      expectedNoPlan: true,
    }, 103)).toBe(false);
    expect(getConstructionJob(db, job.id)).toMatchObject({
      status: "running",
      placedCount: 0,
      lastPlanId: plan.id,
    });
  });

  it("rejects mutually exclusive construction plan guards", () => {
    const blueprint = upsertBlueprint(db, {
      name: "invalid-plan-guard",
      blocks: [{ x: 0, y: 0, z: 0, block: "stone" }],
    });
    const job = createConstructionJob(db, {
      blueprintId: blueprint.id, originX: 0, originY: 64, originZ: 0,
    });

    expect(() => setConstructionStatusIfCurrent(db, {
      jobId: job.id,
      status: "running",
      expectedStatuses: ["pending"],
      expectedPlanId: 1,
      expectedNoPlan: true,
    })).toThrow(/both a plan and no plan/);
  });

  it("does not mutate a blueprint used by a resumable job", () => {
    const blueprint = upsertBlueprint(db, {
      name: "wall",
      blocks: [{ x: 0, y: 0, z: 0, block: "stone" }],
    });
    createConstructionJob(db, {
      blueprintId: blueprint.id,
      originX: 0, originY: 64, originZ: 0,
    });
    expect(() => upsertBlueprint(db, {
      name: "wall",
      blocks: [{ x: 0, y: 0, z: 0, block: "dirt" }],
    })).toThrow(/active construction jobs/);
  });

  it("keeps legacy raw blueprints source-free while atomically persisting trusted compiled sources", () => {
    const raw = upsertBlueprint(db, {
      name: "legacy",
      blocks: [{ x: 0, y: 0, z: 0, block: "stone" }],
    }, 100);
    expect(getBlueprintSource(db, raw.id)).toBeUndefined();

    const compiled = registerCompiledBlueprint(db, {
      name: "generated",
      blocks: [
        { x: 1, y: 0, z: 0, block: "stone" },
        { x: 0, y: 0, z: 0, block: "dirt" },
      ],
      sourceSchema: "smartbot.build/v1",
      targetVersion: "1.21.11",
      sourceJson: '{"schema":"smartbot.build/v1"}',
      sourceHash: "a".repeat(64),
      compileReportJson: '{"placementCount":2}',
      creator: systemActor("owner", "recovery"),
    }, 200);

    expect(compiled.blocks).toEqual([
      { x: 0, y: 0, z: 0, block: "dirt" },
      { x: 1, y: 0, z: 0, block: "stone" },
    ]);
    expect(getBlueprintSource(db, compiled.id)).toEqual({
      blueprintId: compiled.id,
      tsCreated: 200,
      tsUpdated: 200,
      schema: "smartbot.build/v1",
      targetVersion: "1.21.11",
      sourceJson: '{"schema":"smartbot.build/v1"}',
      sourceHash: "a".repeat(64),
      compileReportJson: '{"placementCount":2}',
      creator: { username: "owner", source: "recovery" },
    });
  });

  it("keeps an auditable compiled source and its exact placements after a database restart", () => {
    const compiled = registerCompiledBlueprint(db, {
      name: "restart-generated",
      blocks: [
        { x: 0, y: 0, z: 0, block: "stone" },
        { x: 1, y: 0, z: 0, block: "dirt" },
      ],
      sourceSchema: "smartbot.build/v1",
      targetVersion: "1.21.11",
      sourceJson: '{"name":"restart-generated","schema":"smartbot.build/v1"}',
      sourceHash: "9".repeat(64),
      compileReportJson: '{"placementCount":2}',
      creator: systemActor("owner", "recovery"),
    }, 250);

    db.close();
    db = openDatabase(join(tmp, "memory.sqlite"));

    expect(getBlueprintByName(db, "restart-generated")?.blocks).toEqual([
      { x: 0, y: 0, z: 0, block: "stone" },
      { x: 1, y: 0, z: 0, block: "dirt" },
    ]);
    expect(getBlueprintSource(db, compiled.id)).toMatchObject({
      blueprintId: compiled.id,
      schema: "smartbot.build/v1",
      targetVersion: "1.21.11",
      sourceHash: "9".repeat(64),
      creator: { username: "owner", source: "recovery" },
    });
  });

  it("keeps the raw 256-cell boundary separate from the trusted compiled 4,096-cell boundary", () => {
    const rawCells = Array.from({ length: 257 }, (_, x) => ({ x, y: 0, z: 0, block: "stone" }));
    expect(() => upsertBlueprint(db, { name: "too-large-raw", blocks: rawCells })).toThrow(/at most 256/);

    const trustedCells = Array.from({ length: 4_096 }, (_, x) => ({ x, y: 0, z: 0, block: "stone" }));
    expect(registerCompiledBlueprint(db, {
      name: "large-generated",
      blocks: trustedCells,
      sourceSchema: "smartbot.build/v1",
      targetVersion: "1.21.11",
      sourceJson: "{}",
      sourceHash: "b".repeat(64),
      compileReportJson: "{}",
      creator: systemActor("owner", "recovery"),
    }).blocks).toHaveLength(4_096);
    expect(() => registerCompiledBlueprint(db, {
      name: "too-large-generated",
      blocks: [...trustedCells, { x: 4_096, y: 0, z: 0, block: "stone" }],
      sourceSchema: "smartbot.build/v1",
      targetVersion: "1.21.11",
      sourceJson: "{}",
      sourceHash: "c".repeat(64),
      compileReportJson: "{}",
      creator: systemActor("owner", "recovery"),
    })).toThrow(/at most 4096/);
  });

  it("does not overwrite a compiled blueprint or its source while a resumable job exists", () => {
    const compiled = registerCompiledBlueprint(db, {
      name: "locked-generated",
      blocks: [{ x: 0, y: 0, z: 0, block: "stone" }],
      sourceSchema: "smartbot.build/v1",
      targetVersion: "1.21.11",
      sourceJson: "{}",
      sourceHash: "d".repeat(64),
      compileReportJson: "{}",
      creator: systemActor("owner", "recovery"),
    });
    createConstructionJob(db, { blueprintId: compiled.id, originX: 0, originY: 64, originZ: 0 });

    expect(() => registerCompiledBlueprint(db, {
      name: "locked-generated",
      blocks: [{ x: 0, y: 0, z: 0, block: "dirt" }],
      sourceSchema: "smartbot.build/v1",
      targetVersion: "1.21.11",
      sourceJson: "{}",
      sourceHash: "e".repeat(64),
      compileReportJson: "{}",
      creator: systemActor("owner", "recovery"),
    })).toThrow(/active construction jobs/);
    expect(getBlueprintSource(db, compiled.id)?.sourceHash).toBe("d".repeat(64));
  });

  it("does not let raw registration overwrite an auditable source-backed blueprint", () => {
    const compiled = registerCompiledBlueprint(db, {
      name: "audit-locked",
      blocks: [{ x: 0, y: 0, z: 0, block: "stone" }],
      sourceSchema: "smartbot.build/v1",
      targetVersion: "1.21.11",
      sourceJson: "{}",
      sourceHash: "f".repeat(64),
      compileReportJson: "{}",
      creator: systemActor("owner", "recovery"),
    });

    expect(() => upsertBlueprint(db, {
      name: compiled.name,
      blocks: [{ x: 0, y: 0, z: 0, block: "dirt" }],
    })).toThrow(/source-backed/);
    expect(getBlueprintSource(db, compiled.id)?.sourceHash).toBe("f".repeat(64));
  });

  it("bounds source JSON by bytes and accepts the shared 120-character blueprint name limit", () => {
    const name = "n".repeat(120);
    expect(upsertBlueprint(db, {
      name,
      blocks: [{ x: 0, y: 0, z: 0, block: "stone" }],
    }).name).toBe(name);
    expect(() => registerCompiledBlueprint(db, {
      name: "oversized-source",
      blocks: [{ x: 0, y: 0, z: 0, block: "stone" }],
      sourceSchema: "smartbot.build/v1",
      targetVersion: "1.21.11",
      sourceJson: `"${"x".repeat(32_769)}"`,
      sourceHash: "0".repeat(64),
      compileReportJson: "{}",
      creator: systemActor("owner", "recovery"),
    })).toThrow(/canonical source must be 1-32768 UTF-8 bytes/);
  });
});
