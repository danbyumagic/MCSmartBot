import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createConstructionJob,
  markConstructionPlan,
  registerCompiledBlueprint,
  setConstructionStatus,
  upsertBlueprint,
} from "../../../src/construction/store.js";
import { openDatabase, type DB } from "../../../src/memory/db.js";
import { removePlayerRole, setPlayerRole } from "../../../src/permissions/roles.js";
import {
  planBlueprintMaterials,
  prepareBlueprintMaterials,
} from "../../../src/skills/construction/prepareBlueprintMaterials.js";
import type { SkillContext } from "../../../src/skills/types.js";
import { createTaskPlan } from "../../../src/tasks/store.js";

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

const materialActor = {
  username: "Builder",
  role: "operator" as const,
  source: "minecraft-chat" as const,
};

function makeContext(
  counts: Record<string, number>,
  actor = materialActor,
  planId?: number,
  options: {
    missionRunId?: number;
    /** `null` models a bot which has not exposed a usable game dimension yet. */
    dimension?: string | null;
  } = {},
): SkillContext {
  const log = {
    debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn(), trace: vi.fn(), fatal: vi.fn(),
    child: () => log, level: "error", bindings: () => ({}),
  } as unknown as SkillContext["log"];
  const itemNames = new Set(["oak_log", "oak_planks", ...Object.keys(counts)]);
  return {
    bot: {
      game: options.dimension === null ? {} : { dimension: options.dimension ?? "overworld" },
      inventory: {
        items: () => Object.entries(counts)
          .filter(([, count]) => count > 0)
          .map(([name, count], index) => ({
            name,
            count,
            slot: 9 + index,
            type: 100 + index,
          })),
      },
      registry: {
        itemsByName: Object.fromEntries(
          [...itemNames].map((name, index) => [name, { id: index + 1, stackSize: 64 }]),
        ),
      },
    } as unknown as SkillContext["bot"],
    signal: new AbortController().signal,
    log,
    reportProgress: vi.fn(),
    execution: {
      actor,
      ...(planId === undefined ? {} : { planId }),
      ...(options.missionRunId === undefined ? {} : { missionRunId: options.missionRunId }),
    },
  };
}

function createPreparationSkill(
  overrides: Parameters<typeof prepareBlueprintMaterials>[1] = {},
  access: {
    ownerUsername?: string;
    configuredVersion?: string;
    getLiveVersion?: () => string | undefined;
  } = {},
) {
  return prepareBlueprintMaterials({
    db,
    ownerUsername: access.ownerUsername ?? "Owner",
    configuredVersion: access.configuredVersion ?? "1.21.11",
    getLiveVersion: access.getLiveVersion ?? (() => "1.21.11"),
  }, overrides);
}

describe("prepareBlueprintMaterials", () => {
  it("gathers logs and crafts the exact wood requirements", async () => {
    const blocks = [
      ...Array.from({ length: 8 }, (_, x) => ({ x, y: 0, z: 0, block: "oak_log" })),
      ...Array.from({ length: 8 }, (_, x) => ({ x, y: 1, z: 0, block: "oak_planks" })),
    ];
    const blueprint = upsertBlueprint(db, { name: "wood-test", blocks });
    const job = createConstructionJob(db, {
      blueprintId: blueprint.id,
      originX: 0,
      originY: 65,
      originZ: 0,
    });
    const counts = { oak_log: 0, oak_planks: 0 };
    const chop = vi.fn(async () => {
      counts.oak_log += 10;
      return { ok: true, summary: "felled one tree" };
    });
    const craft = vi.fn(async ({ quantity }: { quantity: number }) => {
      const needed = quantity - counts.oak_planks;
      counts.oak_log -= Math.ceil(needed / 4);
      counts.oak_planks = quantity;
      return { ok: true, summary: "crafted planks" };
    });
    const skill = createPreparationSkill({
      chopTrees: { run: chop } as any,
      craftItem: { run: craft } as any,
    });

    const result = await skill.run({ jobId: job.id }, makeContext(counts));

    expect(result).toMatchObject({
      ok: true,
      data: {
        requirements: { oak_log: 8, oak_planks: 8 },
        placementUnitCount: 16,
        expectedWorldCellCount: 16,
      },
    });
    expect(chop).toHaveBeenCalledOnce();
    expect(craft).toHaveBeenCalledWith(
      expect.objectContaining({ item: "oak_planks", quantity: 8 }),
      expect.anything(),
    );
    expect(counts).toEqual({ oak_log: 8, oak_planks: 8 });
  });

  it("reports unsupported materials only after indexed retrieval is exhausted", async () => {
    const blueprint = upsertBlueprint(db, {
      name: "obsidian-test",
      blocks: [{ x: 0, y: 0, z: 0, block: "obsidian" }],
    });
    const job = createConstructionJob(db, {
      blueprintId: blueprint.id,
      originX: 0,
      originY: 65,
      originZ: 0,
      storageName: "build-stock",
    });
    const retrieve = vi.fn().mockResolvedValue({
      ok: false,
      summary: "no indexed obsidian",
      code: "NO_MATERIAL",
      recoverable: true,
    });

    const result = await createPreparationSkill({
      retrieveItem: { run: retrieve } as any,
    }).run(
      { jobId: job.id },
      makeContext({ obsidian: 0 }),
    );

    expect(result).toMatchObject({
      ok: false,
      code: "NO_MATERIAL",
      recoverable: true,
      details: {
        unsupported: ["obsidian"],
        guidance: expect.stringContaining("indexed storage"),
      },
    });
    expect(retrieve).toHaveBeenCalledWith(
      expect.objectContaining({ item: "obsidian", quantity: 1, chestName: "build-stock" }),
      expect.anything(),
    );
  });

  it("accepts a non-automatic material already carried by the bot", async () => {
    const blueprint = upsertBlueprint(db, {
      name: "stairs-carried",
      blocks: [
        { x: 0, y: 0, z: 0, block: "oak_stairs" },
        { x: 1, y: 0, z: 0, block: "oak_stairs" },
      ],
    });
    const job = createConstructionJob(db, {
      blueprintId: blueprint.id,
      originX: 0,
      originY: 65,
      originZ: 0,
    });
    const retrieve = vi.fn();

    const result = await createPreparationSkill({
      retrieveItem: { run: retrieve } as any,
    }).run({ jobId: job.id }, makeContext({ oak_stairs: 2 }));

    expect(result).toMatchObject({
      ok: true,
      data: { requirements: { oak_stairs: 2 } },
    });
    expect(retrieve).not.toHaveBeenCalled();
  });

  it("accepts a non-automatic material retrieved from configured indexed storage", async () => {
    const blueprint = upsertBlueprint(db, {
      name: "bricks-indexed",
      blocks: [
        { x: 0, y: 0, z: 0, block: "stone_bricks" },
        { x: 1, y: 0, z: 0, block: "stone_bricks" },
      ],
    });
    const job = createConstructionJob(db, {
      blueprintId: blueprint.id,
      originX: 0,
      originY: 65,
      originZ: 0,
      storageName: "build-stock",
    });
    const counts = { stone_bricks: 0 };
    const retrieve = vi.fn(async ({ item, quantity }: { item: string; quantity: number }) => {
      expect(item).toBe("stone_bricks");
      counts.stone_bricks = quantity;
      return { ok: true, summary: "retrieved stone bricks" };
    });

    const result = await createPreparationSkill({
      retrieveItem: { run: retrieve } as any,
    }).run({ jobId: job.id }, makeContext(counts));

    expect(result).toMatchObject({
      ok: true,
      data: { requirements: { stone_bricks: 2 } },
    });
    expect(retrieve).toHaveBeenCalledWith(
      {
        item: "stone_bricks",
        quantity: 2,
        chestName: "build-stock",
        excludeChestName: undefined,
      },
      expect.anything(),
    );
  });

  it("keeps mission preparation retrieval-only when staged materials are missing", async () => {
    const blueprint = upsertBlueprint(db, {
      name: "mission-staged-materials",
      blocks: [{ x: 0, y: 0, z: 0, block: "oak_planks" }],
    });
    const job = createConstructionJob(db, {
      blueprintId: blueprint.id,
      originX: 0,
      originY: 65,
      originZ: 0,
      storageName: "build-stock",
    });
    const plan = createTaskPlan(db, {
      title: "mission preparation",
      steps: [{ skill: "prepareBlueprintMaterials", params: { jobId: job.id } }],
      actor: materialActor,
    });
    expect(markConstructionPlan(db, job.id, plan.id)).toBe(true);
    const retrieve = vi.fn().mockResolvedValue({
      ok: false,
      summary: "no staged planks",
      code: "NO_MATERIAL",
      recoverable: true,
    });
    const chop = vi.fn();
    const mine = vi.fn();
    const craft = vi.fn();
    const smelt = vi.fn();
    const tool = vi.fn();

    const result = await createPreparationSkill({
      retrieveItem: { run: retrieve } as any,
      chopTrees: { run: chop } as any,
      mineUntil: { run: mine } as any,
      craftItem: { run: craft } as any,
      smeltItem: { run: smelt } as any,
      ensureTool: { run: tool } as any,
    }).run(
      { jobId: job.id },
      makeContext({ oak_planks: 0 }, materialActor, plan.id, { missionRunId: 91 }),
    );

    expect(result).toMatchObject({
      ok: false,
      code: "NO_MATERIAL",
      recoverable: true,
      details: {
        jobId: job.id,
        missionRunId: 91,
        missing: [{ item: "oak_planks", quantity: 1, have: 0, missing: 1, satisfied: false }],
        missingCount: 1,
        missingTruncated: false,
        guidance: expect.stringContaining("stage"),
      },
    });
    expect(retrieve).toHaveBeenCalledOnce();
    expect(chop).not.toHaveBeenCalled();
    expect(mine).not.toHaveBeenCalled();
    expect(craft).not.toHaveBeenCalled();
    expect(smelt).not.toHaveBeenCalled();
    expect(tool).not.toHaveBeenCalled();
  });

  it("accepts configured indexed stock for a mission without automatic acquisition", async () => {
    const blueprint = upsertBlueprint(db, {
      name: "mission-indexed-materials",
      blocks: [{ x: 0, y: 0, z: 0, block: "cobblestone" }],
    });
    const job = createConstructionJob(db, {
      blueprintId: blueprint.id,
      originX: 0,
      originY: 65,
      originZ: 0,
      storageName: "build-stock",
    });
    const plan = createTaskPlan(db, {
      title: "mission indexed preparation",
      steps: [{ skill: "prepareBlueprintMaterials", params: { jobId: job.id } }],
      actor: materialActor,
    });
    expect(markConstructionPlan(db, job.id, plan.id)).toBe(true);
    const counts = { cobblestone: 0 };
    const retrieve = vi.fn(async ({ quantity }: { quantity: number }) => {
      counts.cobblestone = quantity;
      return { ok: true, summary: "retrieved staged cobblestone" };
    });
    const mine = vi.fn();
    const tool = vi.fn();

    const result = await createPreparationSkill({
      retrieveItem: { run: retrieve } as any,
      mineUntil: { run: mine } as any,
      ensureTool: { run: tool } as any,
    }).run(
      { jobId: job.id },
      makeContext(counts, materialActor, plan.id, { missionRunId: 93 }),
    );

    expect(result).toMatchObject({ ok: true, data: { requirements: { cobblestone: 1 } } });
    expect(retrieve).toHaveBeenCalledOnce();
    expect(mine).not.toHaveBeenCalled();
    expect(tool).not.toHaveBeenCalled();
  });

  it("bounds mission missing-material diagnostics", async () => {
    const blocks = Array.from({ length: 40 }, (_, index) => ({
      x: index,
      y: 0,
      z: 0,
      block: `missing_material_${index}`,
    }));
    const blueprint = upsertBlueprint(db, { name: "mission-bounded-missing", blocks });
    const job = createConstructionJob(db, {
      blueprintId: blueprint.id,
      originX: 0,
      originY: 65,
      originZ: 0,
    });

    const result = await createPreparationSkill().run(
      { jobId: job.id },
      makeContext({}, materialActor, undefined, { missionRunId: 92 }),
    );

    expect(result).toMatchObject({
      ok: false,
      code: "NO_MATERIAL",
      details: {
        missionRunId: 92,
        missingCount: 40,
        missingTruncated: true,
      },
    });
    expect(result.details?.missing).toHaveLength(32);
  });

  it("rejects unavailable or mismatched dimensions before any material delegate", async () => {
    const blueprint = upsertBlueprint(db, {
      name: "dimension-locked-preparation",
      blocks: [{ x: 0, y: 0, z: 0, block: "oak_planks" }],
    });
    const job = createConstructionJob(db, {
      blueprintId: blueprint.id,
      dimension: "overworld",
      originX: 0,
      originY: 65,
      originZ: 0,
      storageName: "build-stock",
    });
    const retrieve = vi.fn();
    const chop = vi.fn();
    const mine = vi.fn();
    const craft = vi.fn();
    const smelt = vi.fn();
    const tool = vi.fn();
    const skill = createPreparationSkill({
      retrieveItem: { run: retrieve } as any,
      chopTrees: { run: chop } as any,
      mineUntil: { run: mine } as any,
      craftItem: { run: craft } as any,
      smeltItem: { run: smelt } as any,
      ensureTool: { run: tool } as any,
    });

    const unavailable = await skill.run(
      { jobId: job.id },
      makeContext({ oak_planks: 0 }, materialActor, undefined, { dimension: null }),
    );
    const mismatched = await skill.run(
      { jobId: job.id },
      makeContext({ oak_planks: 0 }, materialActor, undefined, { dimension: "the_nether" }),
    );

    expect(unavailable).toMatchObject({
      ok: false,
      code: "WORLD_UNAVAILABLE",
      details: { jobId: job.id, expectedDimension: "overworld" },
    });
    expect(mismatched).toMatchObject({
      ok: false,
      code: "TARGET_UNAVAILABLE",
      details: {
        jobId: job.id,
        expectedDimension: "overworld",
        currentDimension: "the_nether",
      },
    });
    expect(retrieve).not.toHaveBeenCalled();
    expect(chop).not.toHaveBeenCalled();
    expect(mine).not.toHaveBeenCalled();
    expect(craft).not.toHaveBeenCalled();
    expect(smelt).not.toHaveBeenCalled();
    expect(tool).not.toHaveBeenCalled();
  });

  it("ensures a pickaxe before gathering cobblestone", async () => {
    const blueprint = upsertBlueprint(db, {
      name: "cobble-test",
      blocks: [{ x: 0, y: 0, z: 0, block: "cobblestone" }],
    });
    const job = createConstructionJob(db, {
      blueprintId: blueprint.id,
      originX: 0,
      originY: 65,
      originZ: 0,
    });
    const counts = { cobblestone: 0 };
    const tool = vi.fn().mockResolvedValue({
      ok: true, summary: "equipped stone pickaxe",
    });
    const mine = vi.fn(async () => {
      counts.cobblestone = 1;
      return { ok: true, summary: "mined cobblestone" };
    });
    const skill = createPreparationSkill({
      ensureTool: { run: tool } as any,
      mineUntil: { run: mine } as any,
    });

    const result = await skill.run({ jobId: job.id }, makeContext(counts));

    expect(result.ok).toBe(true);
    expect(tool).toHaveBeenCalledWith(
      expect.objectContaining({ block: "stone" }),
      expect.anything(),
    );
    expect(mine).toHaveBeenCalledWith(
      expect.objectContaining({
        block: "stone",
        resultItem: "cobblestone",
        quantity: 1,
      }),
      expect.anything(),
    );
  });

  it("retries partial server crafting batches inside the same preparation step", async () => {
    const blocks = Array.from(
      { length: 8 },
      (_, x) => ({ x, y: 0, z: 0, block: "oak_planks" }),
    );
    const blueprint = upsertBlueprint(db, { name: "partial-craft", blocks });
    const job = createConstructionJob(db, {
      blueprintId: blueprint.id,
      originX: 0,
      originY: 65,
      originZ: 0,
    });
    const counts = { oak_log: 2, oak_planks: 0 };
    const craft = vi.fn(async () => {
      counts.oak_log--;
      counts.oak_planks += 4;
      return counts.oak_planks >= 8
        ? { ok: true, summary: "target reached" }
        : {
            ok: false,
            summary: "partial batch",
            code: "NO_MATERIAL" as const,
            recoverable: true,
          };
    });
    const skill = createPreparationSkill({
      craftItem: { run: craft } as any,
    });

    const result = await skill.run({ jobId: job.id }, makeContext(counts));

    expect(result.ok).toBe(true);
    expect(craft).toHaveBeenCalledTimes(2);
    expect(counts).toEqual({ oak_log: 0, oak_planks: 8 });
  });

  it("requires an exact construction plan match before material preparation can mutate", async () => {
    const blueprint = upsertBlueprint(db, {
      name: "plan-owned-preparation",
      blocks: [{ x: 0, y: 0, z: 0, block: "oak_planks" }],
    });
    const job = createConstructionJob(db, {
      blueprintId: blueprint.id,
      originX: 0, originY: 65, originZ: 0,
    });
    const ownerPlan = createTaskPlan(db, {
      title: "owned preparation",
      steps: [{ skill: "prepareBlueprintMaterials", params: { jobId: job.id } }],
      actor: materialActor,
    });
    const unrelatedPlan = createTaskPlan(db, {
      title: "unrelated preparation",
      steps: [{ skill: "prepareBlueprintMaterials", params: { jobId: job.id } }],
      actor: materialActor,
    });
    expect(markConstructionPlan(db, job.id, ownerPlan.id)).toBe(true);
    const craft = vi.fn();
    const skill = createPreparationSkill({ craftItem: { run: craft } as any });

    const directResult = await skill.run(
      { jobId: job.id },
      makeContext({ oak_log: 1, oak_planks: 0 }),
    );
    const wrongPlanResult = await skill.run(
      { jobId: job.id },
      makeContext({ oak_log: 1, oak_planks: 0 }, materialActor, unrelatedPlan.id),
    );

    for (const result of [directResult, wrongPlanResult]) {
      expect(result).toMatchObject({
        ok: false,
        code: "TARGET_UNAVAILABLE",
        recoverable: true,
        details: { jobId: job.id, expectedPlanId: ownerPlan.id },
      });
    }
    expect(craft).not.toHaveBeenCalled();
  });

  it("denies a revoked source actor before storage retrieval, gathering, crafting, or smelting", async () => {
    setPlayerRole(db, { username: "Builder", role: "operator", grantedBy: "Owner" });
    // Model a role revocation after a generated construction plan was queued.
    expect(removePlayerRole(db, "Builder")).toBe(true);
    const blueprint = registerCompiledBlueprint(db, {
      name: "revoked-source-preparation",
      blocks: [{ x: 0, y: 0, z: 0, block: "oak_planks" }],
      sourceSchema: "smartbot.build/v1",
      targetVersion: "1.21.11",
      sourceJson: '{"schema":"smartbot.build/v1"}',
      sourceHash: "a".repeat(64),
      compileReportJson: '{"requiredAccess":"operator"}',
      creator: { username: "Owner", role: "owner", source: "desktop" },
    });
    const job = createConstructionJob(db, {
      blueprintId: blueprint.id,
      originX: 0, originY: 65, originZ: 0,
      storageName: "build-stock",
    });
    const retrieve = vi.fn();
    const chop = vi.fn();
    const mine = vi.fn();
    const craft = vi.fn();
    const smelt = vi.fn();

    const result = await createPreparationSkill({
      retrieveItem: { run: retrieve } as any,
      chopTrees: { run: chop } as any,
      mineUntil: { run: mine } as any,
      craftItem: { run: craft } as any,
      smeltItem: { run: smelt } as any,
    }).run({ jobId: job.id }, makeContext({ oak_log: 0, oak_planks: 0 }));

    expect(result).toMatchObject({ ok: false, code: "PERMISSION_DENIED", recoverable: false });
    expect(result.summary).toContain("requires operator access");
    expect(retrieve).not.toHaveBeenCalled();
    expect(chop).not.toHaveBeenCalled();
    expect(mine).not.toHaveBeenCalled();
    expect(craft).not.toHaveBeenCalled();
    expect(smelt).not.toHaveBeenCalled();
  });

  it("denies a source version mismatch before any delegated material action", async () => {
    setPlayerRole(db, { username: "Builder", role: "operator", grantedBy: "Owner" });
    const blueprint = registerCompiledBlueprint(db, {
      name: "version-locked-preparation",
      blocks: [{ x: 0, y: 0, z: 0, block: "cobblestone" }],
      sourceSchema: "smartbot.build/v1",
      targetVersion: "1.21.11",
      sourceJson: '{"schema":"smartbot.build/v1"}',
      sourceHash: "b".repeat(64),
      compileReportJson: '{"requiredAccess":"operator"}',
      creator: { username: "Owner", role: "owner", source: "desktop" },
    });
    const job = createConstructionJob(db, {
      blueprintId: blueprint.id,
      originX: 0, originY: 65, originZ: 0,
      storageName: "build-stock",
    });
    const getLiveVersion = vi.fn(() => "1.21.10");
    const retrieve = vi.fn();
    const mine = vi.fn();
    const craft = vi.fn();
    const chop = vi.fn();

    const result = await createPreparationSkill({
      retrieveItem: { run: retrieve } as any,
      mineUntil: { run: mine } as any,
      craftItem: { run: craft } as any,
      chopTrees: { run: chop } as any,
    }, { getLiveVersion }).run(
      { jobId: job.id },
      makeContext({ cobblestone: 0 }),
    );

    expect(result).toMatchObject({ ok: false, code: "PERMISSION_DENIED", recoverable: false });
    expect(result.summary).toContain("targets Minecraft 1.21.11, but live bot is 1.21.10");
    expect(getLiveVersion).toHaveBeenCalledOnce();
    expect(retrieve).not.toHaveBeenCalled();
    expect(mine).not.toHaveBeenCalled();
    expect(craft).not.toHaveBeenCalled();
    expect(chop).not.toHaveBeenCalled();
  });

  it("denies a configured source version mismatch before any delegated material action", async () => {
    setPlayerRole(db, { username: "Builder", role: "operator", grantedBy: "Owner" });
    const blueprint = registerCompiledBlueprint(db, {
      name: "configured-version-locked-preparation",
      blocks: [{ x: 0, y: 0, z: 0, block: "cobblestone" }],
      sourceSchema: "smartbot.build/v1",
      targetVersion: "1.21.11",
      sourceJson: '{"schema":"smartbot.build/v1"}',
      sourceHash: "e".repeat(64),
      compileReportJson: '{"requiredAccess":"operator"}',
      creator: { username: "Owner", role: "owner", source: "desktop" },
    });
    const job = createConstructionJob(db, {
      blueprintId: blueprint.id,
      originX: 0, originY: 65, originZ: 0,
    });
    const mine = vi.fn();

    const result = await createPreparationSkill({
      mineUntil: { run: mine } as any,
    }, {
      configuredVersion: "1.21.10",
      getLiveVersion: () => "1.21.11",
    }).run({ jobId: job.id }, makeContext({ cobblestone: 0 }));

    expect(result).toMatchObject({ ok: false, code: "PERMISSION_DENIED", recoverable: false });
    expect(result.summary).toContain("targets Minecraft 1.21.11, but configured runtime is 1.21.10");
    expect(mine).not.toHaveBeenCalled();
  });

  it("fails closed when a source-backed preparation cannot read the live bot version", async () => {
    setPlayerRole(db, { username: "Builder", role: "operator", grantedBy: "Owner" });
    const blueprint = registerCompiledBlueprint(db, {
      name: "unavailable-live-version-preparation",
      blocks: [{ x: 0, y: 0, z: 0, block: "cobblestone" }],
      sourceSchema: "smartbot.build/v1",
      targetVersion: "1.21.11",
      sourceJson: '{"schema":"smartbot.build/v1"}',
      sourceHash: "c".repeat(64),
      compileReportJson: '{"requiredAccess":"operator"}',
      creator: { username: "Owner", role: "owner", source: "desktop" },
    });
    const job = createConstructionJob(db, {
      blueprintId: blueprint.id,
      originX: 0, originY: 65, originZ: 0,
    });
    const getLiveVersion = vi.fn(() => undefined);
    const mine = vi.fn();

    const result = await createPreparationSkill({
      mineUntil: { run: mine } as any,
    }, { getLiveVersion }).run(
      { jobId: job.id },
      makeContext({ cobblestone: 0 }),
    );

    expect(result).toMatchObject({ ok: false, code: "PERMISSION_DENIED", recoverable: false });
    expect(result.summary).toContain("live Minecraft version is unavailable");
    expect(getLiveVersion).toHaveBeenCalledOnce();
    expect(mine).not.toHaveBeenCalled();
  });

  it("rechecks source authority after a delegated gather before crafting", async () => {
    setPlayerRole(db, { username: "Builder", role: "operator", grantedBy: "Owner" });
    const blueprint = registerCompiledBlueprint(db, {
      name: "revoked-during-preparation",
      blocks: [{ x: 0, y: 0, z: 0, block: "oak_planks" }],
      sourceSchema: "smartbot.build/v1",
      targetVersion: "1.21.11",
      sourceJson: '{"schema":"smartbot.build/v1"}',
      sourceHash: "d".repeat(64),
      compileReportJson: '{"requiredAccess":"operator"}',
      creator: { username: "Owner", role: "owner", source: "desktop" },
    });
    const job = createConstructionJob(db, {
      blueprintId: blueprint.id,
      originX: 0, originY: 65, originZ: 0,
    });
    const counts = { oak_log: 0, oak_planks: 0 };
    const chop = vi.fn(async () => {
      counts.oak_log = 1;
      expect(removePlayerRole(db, "Builder")).toBe(true);
      return { ok: true, summary: "felled one tree" };
    });
    const craft = vi.fn();

    const result = await createPreparationSkill({
      chopTrees: { run: chop } as any,
      craftItem: { run: craft } as any,
    }).run({ jobId: job.id }, makeContext(counts));

    expect(result).toMatchObject({ ok: false, code: "PERMISSION_DENIED", recoverable: false });
    expect(result.summary).toContain("requires operator access");
    expect(chop).toHaveBeenCalledOnce();
    expect(craft).not.toHaveBeenCalled();
  });

  it("rechecks the live source version after a delegated gather before crafting", async () => {
    setPlayerRole(db, { username: "Builder", role: "operator", grantedBy: "Owner" });
    const blueprint = registerCompiledBlueprint(db, {
      name: "version-changed-during-preparation",
      blocks: [{ x: 0, y: 0, z: 0, block: "oak_planks" }],
      sourceSchema: "smartbot.build/v1",
      targetVersion: "1.21.11",
      sourceJson: '{"schema":"smartbot.build/v1"}',
      sourceHash: "f".repeat(64),
      compileReportJson: '{"requiredAccess":"operator"}',
      creator: { username: "Owner", role: "owner", source: "desktop" },
    });
    const job = createConstructionJob(db, {
      blueprintId: blueprint.id,
      originX: 0, originY: 65, originZ: 0,
    });
    const counts = { oak_log: 0, oak_planks: 0 };
    const chop = vi.fn(async () => {
      counts.oak_log = 1;
      return { ok: true, summary: "felled one tree" };
    });
    const craft = vi.fn();
    const getLiveVersion = vi.fn()
      .mockReturnValueOnce("1.21.11")
      .mockReturnValueOnce("1.21.11")
      .mockReturnValueOnce("1.21.10");

    const result = await createPreparationSkill({
      chopTrees: { run: chop } as any,
      craftItem: { run: craft } as any,
    }, { getLiveVersion }).run({ jobId: job.id }, makeContext(counts));

    expect(result).toMatchObject({ ok: false, code: "PERMISSION_DENIED", recoverable: false });
    expect(result.summary).toContain("targets Minecraft 1.21.11, but live bot is 1.21.10");
    expect(getLiveVersion).toHaveBeenCalledTimes(3);
    expect(chop).toHaveBeenCalledOnce();
    expect(craft).not.toHaveBeenCalled();
  });

  it("keeps raw material preparation executable without consulting a live source-version provider", async () => {
    const blueprint = upsertBlueprint(db, {
      name: "raw-preparation-without-live-version",
      blocks: [{ x: 0, y: 0, z: 0, block: "oak_planks" }],
    });
    const job = createConstructionJob(db, {
      blueprintId: blueprint.id,
      originX: 0, originY: 65, originZ: 0,
    });
    const counts = { oak_log: 1, oak_planks: 0 };
    const getLiveVersion = vi.fn(() => undefined);
    const craft = vi.fn(async () => {
      counts.oak_planks = 1;
      return { ok: true, summary: "crafted planks" };
    });

    const result = await createPreparationSkill({
      craftItem: { run: craft } as any,
    }, { getLiveVersion }).run({ jobId: job.id }, makeContext(counts));

    expect(result).toMatchObject({ ok: true, data: { requirements: { oak_planks: 1 } } });
    expect(craft).toHaveBeenCalledOnce();
    expect(getLiveVersion).not.toHaveBeenCalled();
  });

  it("does not let a direct preparation invocation mutate a paused job", async () => {
    const blueprint = upsertBlueprint(db, {
      name: "paused-direct-preparation",
      blocks: [{ x: 0, y: 0, z: 0, block: "oak_planks" }],
    });
    const job = createConstructionJob(db, {
      blueprintId: blueprint.id,
      originX: 0, originY: 65, originZ: 0,
    });
    expect(setConstructionStatus(db, job.id, "paused")).toBe(true);
    const chop = vi.fn();
    const craft = vi.fn();

    const result = await createPreparationSkill({
      chopTrees: { run: chop } as any,
      craftItem: { run: craft } as any,
    }).run({ jobId: job.id }, makeContext({ oak_log: 0, oak_planks: 0 }));

    expect(result).toMatchObject({ ok: false, code: "INTERRUPTED" });
    expect(chop).not.toHaveBeenCalled();
    expect(craft).not.toHaveBeenCalled();
  });

  it("prices synthetic multi-cell placement units by inventory item, not world cells", () => {
    const materialPlan = planBlueprintMaterials({
      placementUnits: [
        {
          anchor: { x: 0, y: 0, z: 0, block: "oak_door" },
          item: "oak_door",
          expectedCells: [
            { x: 0, y: 0, z: 0, block: "oak_door" },
            { x: 0, y: 1, z: 0, block: "oak_door" },
          ],
        },
        {
          anchor: { x: 1, y: 0, z: 0, block: "cobblestone" },
          item: "cobblestone",
          expectedCells: [{ x: 1, y: 0, z: 0, block: "cobblestone" }],
        },
      ],
    });

    expect(materialPlan).toMatchObject({
      placementUnitCount: 2,
      expectedWorldCellCount: 3,
    });
    expect(materialPlan.requirements).toEqual(new Map([
      ["oak_door", 1],
      ["cobblestone", 1],
    ]));
  });
});
