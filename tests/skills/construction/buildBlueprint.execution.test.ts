import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Vec3 } from "vec3";
import {
  createConstructionJob,
  getConstructionJob,
  markConstructionPlan,
  registerCompiledBlueprint,
  upsertBlueprint,
} from "../../../src/construction/store.js";
import { openDatabase, type DB } from "../../../src/memory/db.js";
import { snapshotExecutionActor, type ExecutionActor } from "../../../src/permissions/executionActor.js";
import { setPlayerRole } from "../../../src/permissions/roles.js";
import {
  MAX_BUILD_REPAIR_UNITS,
  buildBlueprint,
} from "../../../src/skills/construction/buildBlueprint.js";
import type { SkillContext } from "../../../src/skills/types.js";
import { createTaskPlan } from "../../../src/tasks/store.js";
import { createWorldTransactionService } from "../../../src/world/transactions/service.js";
import { getTransaction, listTransactions } from "../../../src/world/transactions/store.js";

let tmp: string;
let db: DB;

const actor: ExecutionActor = snapshotExecutionActor({
  username: "Builder",
  role: "operator",
  source: "minecraft-chat",
});

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "smbmc-build-execution-"));
  db = openDatabase(join(tmp, "memory.sqlite"));
});

afterEach(() => {
  db.close();
  rmSync(tmp, { recursive: true, force: true });
});

function makeSkill() {
  return buildBlueprint({
    db,
    transactions: createWorldTransactionService({ db }),
    serverKey: "test.example:25565",
    ownerUsername: "owner",
    configuredVersion: "1.21.11",
    getLiveVersion: () => "1.21.11",
  });
}

function makeContext(
  bot: unknown,
  options: {
    controller?: AbortController;
    planId?: number;
    maxWorldChanges?: number;
    reportProgress?: ReturnType<typeof vi.fn>;
  } = {},
): SkillContext {
  const log = {
    debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn(), trace: vi.fn(), fatal: vi.fn(),
    child: () => log, level: "error", bindings: () => ({}),
  } as unknown as SkillContext["log"];
  return {
    bot: bot as SkillContext["bot"],
    signal: options.controller?.signal ?? new AbortController().signal,
    log,
    reportProgress: options.reportProgress ?? vi.fn(),
    execution: {
      actor,
      ...(options.planId === undefined ? {} : { planId: options.planId }),
      ...(options.maxWorldChanges === undefined ? {} : { maxWorldChanges: options.maxWorldChanges }),
    },
  };
}

function worldKey(position: { x: number; y: number; z: number }): string {
  return `${Math.floor(position.x)},${Math.floor(position.y)},${Math.floor(position.z)}`;
}

function scaffoldSnapshot(position: { x: number; y: number; z: number }, name: string) {
  return {
    position,
    name,
    properties: {},
    boundingBox: name === "air" ? "empty" as const : "block" as const,
    replaceable: name === "air",
    diggable: true,
    key: `${worldKey(position)}:${name}`,
  };
}

function makeBot(input: {
  world: Map<string, string>;
  inventory: Record<string, number>;
  controller?: AbortController;
  /**
   * Runs after the fake has captured the current block into its returned
   * Mineflayer-like object. Tests use this to model another actor changing a
   * block just after the executor's own postcondition read.
   */
  afterBlockRead?: (position: Vec3, name: string) => void;
  /** Fail one ordinary placement after the executor has planned it. */
  failPlacementAt?: number;
}) {
  const held = { item: undefined as string | undefined };
  let placementCalls = 0;
  const entity = { position: new Vec3(-2, 65, -2) };
  const registry = {
    itemsByName: {
      stone: { id: 1 },
      dirt: { id: 2 },
      cobblestone: { id: 3 },
      oak_planks: { id: 4 },
    },
  };
  const blockAt = vi.fn((position: Vec3) => {
    const target = new Vec3(Math.floor(position.x), Math.floor(position.y), Math.floor(position.z));
    // Keep each independently verified placement in ordinary reach without
    // hiding the target from the stale-state checks. This fake models a bot
    // that has already navigated beside the currently read cell.
    entity.position = new Vec3(target.x, target.y, target.z - 2);
    const name = input.world.get(worldKey(target)) ?? "air";
    const block = {
      name,
      position: target,
      boundingBox: name === "air" ? "empty" : "block",
      diggable: true,
      getProperties: () => ({}),
    };
    input.afterBlockRead?.(target, name);
    return block;
  });
  const equip = vi.fn(async (item: { name: string }) => {
    held.item = item.name;
  });
  const placeBlock = vi.fn(async (reference: { position: Vec3 }, face: Vec3) => {
    placementCalls++;
    if (input.failPlacementAt === placementCalls) {
      throw new Error("test placement rejected after journal planning");
    }
    if (!held.item) throw new Error("test bot tried to place without an equipped item");
    const count = input.inventory[held.item] ?? 0;
    if (count <= 0) throw new Error(`test bot ran out of ${held.item}`);
    const target = reference.position.plus(face);
    input.world.set(worldKey(target), held.item);
    input.inventory[held.item] = count - 1;
    input.controller?.abort();
  });
  const dig = vi.fn(async (block: { position: Vec3 }) => {
    input.world.delete(worldKey(block.position));
  });
  return {
    bot: {
      game: { dimension: "overworld" },
      registry,
      entity,
      inventory: {
        items: () => Object.entries(input.inventory)
          .filter(([, count]) => count > 0)
          .map(([name, count]) => ({ name, type: registry.itemsByName[name as keyof typeof registry.itemsByName]?.id, count })),
      },
      blockAt,
      equip,
      placeBlock,
      dig,
      canDigBlock: () => true,
    },
    blockAt,
    equip,
    placeBlock,
    dig,
  };
}

function createBuildPlan(jobId: number): number {
  const plan = createTaskPlan(db, {
    title: `build ${jobId}`,
    steps: [{ skill: "buildBlueprint", params: { jobId } }],
    actor,
  });
  expect(markConstructionPlan(db, jobId, plan.id)).toBe(true);
  return plan.id;
}

describe("buildBlueprint journaled execution", () => {
  it("journals only missing units and links the completed construction attempt to its plan and actor", async () => {
    const blueprint = upsertBlueprint(db, {
      name: "journal-one-missing",
      blocks: [
        { x: 0, y: 0, z: 0, block: "stone" },
        { x: 1, y: 0, z: 0, block: "stone" },
      ],
    });
    const job = createConstructionJob(db, {
      blueprintId: blueprint.id,
      originX: 0,
      originY: 65,
      originZ: 0,
    });
    const planId = createBuildPlan(job.id);
    const world = new Map<string, string>([
      ["0,65,0", "stone"],
      ["0,64,0", "stone"],
      ["1,64,0", "stone"],
    ]);
    const fake = makeBot({ world, inventory: { stone: 1 } });

    const result = await makeSkill().run(
      { jobId: job.id },
      makeContext(fake.bot, { planId }),
    );

    expect(result).toMatchObject({ ok: true, data: { placed: 1, alreadyCorrect: 1, total: 2 } });
    expect(fake.placeBlock).toHaveBeenCalledOnce();
    expect(getConstructionJob(db, job.id)).toMatchObject({ status: "completed", placedCount: 2 });

    const transactionRow = listTransactions(db, { serverKey: "test.example:25565" });
    expect(transactionRow).toHaveLength(1);
    expect(transactionRow[0]).toMatchObject({
      kind: "construction",
      status: "completed",
      serverKey: "test.example:25565",
      dimension: "overworld",
      constructionJobId: job.id,
      taskPlanId: planId,
      actor,
      requestedChangeCount: 1,
      appliedChangeCount: 1,
    });
    const transaction = getTransaction(db, transactionRow[0]!.id)!;
    expect(transaction.changes).toEqual([
      expect.objectContaining({
        ordinal: 1,
        action: "place",
        position: { x: 1, y: 65, z: 0 },
        status: "applied",
        intended: expect.objectContaining({ name: "stone" }),
      }),
    ]);
  });

  it("rejects a budget smaller than primary plus scaffold placement and cleanup before any bot mutation", async () => {
    const blueprint = upsertBlueprint(db, {
      name: "scaffold-budget",
      blocks: [{ x: 0, y: 0, z: 0, block: "stone" }],
    });
    const job = createConstructionJob(db, {
      blueprintId: blueprint.id,
      originX: 0,
      originY: 65,
      originZ: 0,
    });
    // The only nearby support is two blocks below a side click, so this needs
    // two temporary scaffolds, one primary click, and two cleanup digs.
    const world = new Map<string, string>([["1,63,0", "stone"]]);
    const fake = makeBot({ world, inventory: { stone: 1, dirt: 2 } });

    const result = await makeSkill().run(
      { jobId: job.id },
      makeContext(fake.bot, { maxWorldChanges: 4 }),
    );

    expect(result).toMatchObject({ ok: false, code: "BUDGET_EXCEEDED" });
    expect(fake.equip).not.toHaveBeenCalled();
    expect(fake.placeBlock).not.toHaveBeenCalled();
    expect(fake.dig).not.toHaveBeenCalled();
    expect(getConstructionJob(db, job.id)).toMatchObject({ status: "blocked", placedCount: 0 });
    const transaction = listTransactions(db, { serverKey: "test.example:25565" });
    expect(transaction).toHaveLength(1);
    expect(transaction[0]).toMatchObject({ status: "cancelled", requestedChangeCount: 0, appliedChangeCount: 0 });
  });

  it("reserves temporary support across the whole plan before the first mutation", async () => {
    const blueprint = upsertBlueprint(db, {
      name: "two-floating-units-one-support-stack",
      blocks: [
        { x: 0, y: 0, z: 0, block: "stone" },
        { x: 3, y: 0, z: 0, block: "stone" },
      ],
    });
    const job = createConstructionJob(db, {
      blueprintId: blueprint.id,
      originX: 0,
      originY: 65,
      originZ: 0,
    });
    // Each separated target needs two dirt blocks at its own side support
    // column. Two dirt can satisfy one stack but not both, and planning must
    // not assume the first cleanup will produce usable inventory in time.
    const world = new Map<string, string>([
      ["1,63,0", "stone"],
      ["4,63,0", "stone"],
    ]);
    const fake = makeBot({ world, inventory: { stone: 2, dirt: 2 } });

    const result = await makeSkill().run({ jobId: job.id }, makeContext(fake.bot));

    expect(result).toMatchObject({
      ok: false,
      code: "NO_MATERIAL",
      details: { requiresScaffold: true },
    });
    expect(fake.equip).not.toHaveBeenCalled();
    expect(fake.placeBlock).not.toHaveBeenCalled();
    expect(fake.dig).not.toHaveBeenCalled();
    expect(getConstructionJob(db, job.id)).toMatchObject({ status: "blocked", placedCount: 0 });
    expect(listTransactions(db, { serverKey: "test.example:25565" })).toHaveLength(0);
  });

  it("blocks rather than completing when an existing planned construction click is unresolved even if the target now looks correct", async () => {
    const blueprint = upsertBlueprint(db, {
      name: "unresolved-planned-click",
      blocks: [{ x: 0, y: 0, z: 0, block: "stone" }],
    });
    const job = createConstructionJob(db, {
      blueprintId: blueprint.id,
      originX: 0,
      originY: 65,
      originZ: 0,
    });
    const planId = createBuildPlan(job.id);
    const transactions = createWorldTransactionService({ db });
    const attempt = transactions.beginOrReuseConstructionAttempt({
      serverKey: "test.example:25565",
      dimension: "overworld",
      constructionJobId: job.id,
      taskPlanId: planId,
      actor,
      label: "pre-crash construction click",
      budgetScope: `plan:${planId}`,
    });
    const hooks = transactions.createConstructionMutationHooks({
      transactionId: attempt.id,
      ordinal: 0,
    });
    await hooks.planned?.({
      action: "place",
      position: { x: 0, y: 65, z: 0 },
      before: {
        position: { x: 0, y: 65, z: 0 }, name: "air", properties: {},
        boundingBox: "empty", replaceable: true, diggable: true, key: "before",
      },
      intended: { name: "stone" },
    });
    const world = new Map<string, string>([
      ["0,65,0", "stone"],
      ["0,64,0", "stone"],
    ]);
    const fake = makeBot({ world, inventory: { stone: 0 } });

    const result = await makeSkill().run(
      { jobId: job.id },
      makeContext(fake.bot, { planId }),
    );

    expect(result).toMatchObject({ ok: false, code: "WORLD_UNAVAILABLE" });
    expect(fake.placeBlock).not.toHaveBeenCalled();
    expect(getConstructionJob(db, job.id)).toMatchObject({ status: "blocked", placedCount: 1 });
    expect(getTransaction(db, attempt.id)).toMatchObject({
      status: "open",
      requestedChangeCount: 1,
      appliedChangeCount: 0,
      changes: [expect.objectContaining({ ordinal: 0, status: "planned" })],
    });
  });

  it("does not let a direct no-plan invocation create a competing construction attempt", async () => {
    const blueprint = upsertBlueprint(db, {
      name: "scheduled-plan-isolation",
      blocks: [{ x: 0, y: 0, z: 0, block: "stone" }],
    });
    const job = createConstructionJob(db, {
      blueprintId: blueprint.id,
      originX: 0,
      originY: 65,
      originZ: 0,
    });
    const planId = createBuildPlan(job.id);
    const world = new Map<string, string>([["0,64,0", "stone"]]);
    const fake = makeBot({ world, inventory: { stone: 1 } });

    // `createSkillTool` invokes registered skills with an actor but no task
    // plan. It must not run a job that is durably owned by this plan.
    const result = await makeSkill().run({ jobId: job.id }, makeContext(fake.bot));

    expect(result).toMatchObject({
      ok: false,
      code: "TARGET_UNAVAILABLE",
      details: { expectedPlanId: planId, currentPlanId: null },
    });
    expect(fake.placeBlock).not.toHaveBeenCalled();
    expect(getConstructionJob(db, job.id)).toMatchObject({ status: "running", lastPlanId: planId });
    expect(listTransactions(db, { serverKey: "test.example:25565" })).toHaveLength(0);
  });

  it("cannot block a plan-owned job merely by invoking it directly from the wrong dimension", async () => {
    const blueprint = upsertBlueprint(db, {
      name: "scheduled-wrong-dimension-isolation",
      blocks: [{ x: 0, y: 0, z: 0, block: "stone" }],
    });
    const job = createConstructionJob(db, {
      blueprintId: blueprint.id,
      originX: 0,
      originY: 65,
      originZ: 0,
    });
    const planId = createBuildPlan(job.id);
    const fake = makeBot({ world: new Map([["0,64,0", "stone"]]), inventory: { stone: 1 } });
    fake.bot.game.dimension = "the_nether";

    const result = await makeSkill().run({ jobId: job.id }, makeContext(fake.bot));

    expect(result).toMatchObject({
      ok: false,
      code: "TARGET_UNAVAILABLE",
      details: { expectedPlanId: planId, currentPlanId: null },
    });
    expect(fake.placeBlock).not.toHaveBeenCalled();
    expect(getConstructionJob(db, job.id)).toMatchObject({ status: "running", lastPlanId: planId });
    expect(listTransactions(db, { serverKey: "test.example:25565" })).toHaveLength(0);
  });

  it("keeps a post-click abort noncompleted and records its confirmed prefix as partial", async () => {
    const blueprint = upsertBlueprint(db, {
      name: "abort-after-click",
      blocks: [{ x: 0, y: 0, z: 0, block: "stone" }],
    });
    const job = createConstructionJob(db, {
      blueprintId: blueprint.id,
      originX: 0,
      originY: 65,
      originZ: 0,
    });
    const controller = new AbortController();
    const world = new Map<string, string>([["0,64,0", "stone"]]);
    const fake = makeBot({ world, inventory: { stone: 1 }, controller });

    const result = await makeSkill().run(
      { jobId: job.id },
      makeContext(fake.bot, { controller }),
    );

    expect(result).toMatchObject({ ok: false, code: "INTERRUPTED" });
    expect(world.get("0,65,0")).toBe("stone");
    // The click is journal-confirmed before the abort is observed, so durable
    // progress must not lag the verified world prefix.
    expect(getConstructionJob(db, job.id)).toMatchObject({ status: "blocked", placedCount: 1 });
    const transaction = listTransactions(db, { serverKey: "test.example:25565" });
    expect(transaction).toHaveLength(1);
    expect(transaction[0]).toMatchObject({ status: "partial", requestedChangeCount: 1, appliedChangeCount: 1 });
    expect(getTransaction(db, transaction[0]!.id)?.changes).toEqual([
      expect.objectContaining({ status: "applied", action: "place" }),
    ]);
  });

  it("does not complete when temporary scaffold cleanup fails after the primary placement", async () => {
    const blueprint = upsertBlueprint(db, {
      name: "cleanup-failure-after-primary",
      blocks: [{ x: 0, y: 0, z: 0, block: "stone" }],
    });
    const job = createConstructionJob(db, {
      blueprintId: blueprint.id,
      originX: 0,
      originY: 65,
      originZ: 0,
    });
    const world = new Map<string, string>([["1,63,0", "stone"]]);
    const fake = makeBot({ world, inventory: { stone: 1, dirt: 2 } });
    const cleanupDig = vi.fn(async () => {
      throw new Error("test scaffold cleanup denied");
    });
    fake.bot.dig = cleanupDig;

    const result = await makeSkill().run({ jobId: job.id }, makeContext(fake.bot));

    expect(result).toMatchObject({ ok: false, code: "UNKNOWN" });
    expect(world.get("0,65,0")).toBe("stone");
    expect(cleanupDig).toHaveBeenCalledOnce();
    // The expected target cell is confirmed even though the operation must be
    // blocked until its temporary world residue can be handled safely.
    expect(getConstructionJob(db, job.id)).toMatchObject({ status: "blocked", placedCount: 1 });
    const transaction = listTransactions(db, { serverKey: "test.example:25565" });
    expect(transaction).toHaveLength(1);
    expect(transaction[0]).toMatchObject({
      status: "partial",
      requestedChangeCount: 4,
      appliedChangeCount: 3,
    });
    expect(getTransaction(db, transaction[0]!.id)?.changes).toEqual(expect.arrayContaining([
      expect.objectContaining({ action: "place", position: { x: 0, y: 65, z: 0 }, status: "applied" }),
      expect.objectContaining({ action: "dig", status: "failed" }),
    ]));
  });

  it("leaves the attempt partial when scaffold cleanup becomes a solid unexpected block", async () => {
    const blueprint = upsertBlueprint(db, {
      name: "cleanup-solid-postcondition",
      blocks: [{ x: 0, y: 0, z: 0, block: "stone" }],
    });
    const job = createConstructionJob(db, {
      blueprintId: blueprint.id,
      originX: 0,
      originY: 65,
      originZ: 0,
    });
    const world = new Map<string, string>([["1,63,0", "stone"]]);
    const fake = makeBot({ world, inventory: { stone: 1, dirt: 2 } });
    const replacementDig = vi.fn(async (block: { position: Vec3 }) => {
      // Simulate an external/server side replacement observable immediately
      // after Mineflayer reports the dig. Generic dig verification sees a
      // changed state; scaffold cleanup must reject this solid result.
      world.set(worldKey(block.position), "owner_build");
    });
    fake.bot.dig = replacementDig;

    const result = await makeSkill().run({ jobId: job.id }, makeContext(fake.bot));

    expect(result).toMatchObject({ ok: false, code: "STALE_STATE" });
    expect(world.get("0,65,0")).toBe("stone");
    expect(replacementDig).toHaveBeenCalledOnce();
    expect(getConstructionJob(db, job.id)).toMatchObject({ status: "blocked", placedCount: 1 });
    const transaction = listTransactions(db, { serverKey: "test.example:25565" });
    expect(transaction).toHaveLength(1);
    expect(transaction[0]).toMatchObject({ status: "partial", appliedChangeCount: 4 });
    expect(getTransaction(db, transaction[0]!.id)?.changes).toEqual(expect.arrayContaining([
      expect.objectContaining({
        action: "dig",
        status: "applied",
        confirmedAfter: expect.objectContaining({ name: "owner_build" }),
      }),
    ]));
  });

  it("keeps a retry blocked when cleanup previously left an unexpected solid block", async () => {
    const blueprint = upsertBlueprint(db, {
      name: "cleanup-solid-retry-blocked",
      blocks: [{ x: 0, y: 0, z: 0, block: "stone" }],
    });
    const job = createConstructionJob(db, {
      blueprintId: blueprint.id,
      originX: 0,
      originY: 65,
      originZ: 0,
    });
    const world = new Map<string, string>([["1,63,0", "stone"]]);
    const fake = makeBot({ world, inventory: { stone: 1, dirt: 2 } });
    fake.bot.dig = vi.fn(async (block: { position: Vec3 }) => {
      world.set(worldKey(block.position), "owner_build");
    });

    const first = await makeSkill().run({ jobId: job.id }, makeContext(fake.bot));
    expect(first).toMatchObject({ ok: false, code: "STALE_STATE" });
    const clicksAfterFirst = fake.placeBlock.mock.calls.length;
    const firstTransaction = getTransaction(
      db,
      listTransactions(db, { serverKey: "test.example:25565" })[0]!.id,
    )!;
    const unexpectedCleanup = firstTransaction.changes.find((change) =>
      change.action === "dig" && change.status === "applied" &&
      change.confirmedAfter?.name === "owner_build",
    );
    expect(unexpectedCleanup).toBeDefined();
    // Other same-run supports are independently historical candidates. Clear
    // them in this fixture so this retry specifically proves that the observed
    // solid cleanup result itself remains a safety blocker.
    for (const change of firstTransaction.changes) {
      if (change.action === "place" && change.intended.name === "dirt") {
        world.delete(worldKey(change.position));
      }
    }
    world.set(worldKey(unexpectedCleanup!.position), "owner_build");

    const retry = await makeSkill().run({ jobId: job.id }, makeContext(fake.bot));

    expect(retry).toMatchObject({
      ok: false,
      code: "AREA_UNSAFE",
      details: expect.objectContaining({ cleanupObserved: "owner_build", observed: "owner_build" }),
    });
    expect(fake.placeBlock).toHaveBeenCalledTimes(clicksAfterFirst);
    expect(getConstructionJob(db, job.id)).toMatchObject({ status: "failed", placedCount: 1 });
  });

  it("never auto-digs a same-name historical scaffold candidate after failed cleanup", async () => {
    const blueprint = upsertBlueprint(db, {
      name: "historical-scaffold-same-name",
      blocks: [{ x: 0, y: 0, z: 0, block: "stone" }],
    });
    const job = createConstructionJob(db, {
      blueprintId: blueprint.id,
      originX: 0,
      originY: 65,
      originZ: 0,
    });
    const world = new Map<string, string>([["1,63,0", "stone"]]);
    const fake = makeBot({ world, inventory: { stone: 1, dirt: 2 } });
    const cleanupDig = vi.fn(async () => {
      throw new Error("test scaffold cleanup denied");
    });
    fake.bot.dig = cleanupDig;

    const first = await makeSkill().run({ jobId: job.id }, makeContext(fake.bot));
    expect(first).toMatchObject({ ok: false, code: "UNKNOWN" });
    const firstTransaction = getTransaction(
      db,
      listTransactions(db, { serverKey: "test.example:25565" })[0]!.id,
    )!;
    const historicalScaffold = firstTransaction.changes.find((change) =>
      change.action === "place" && change.status === "applied" && change.intended.name === "dirt",
    );
    expect(historicalScaffold).toBeDefined();

    // This is intentionally indistinguishable from the original dirt support:
    // a player could have removed/replaced it after the failed cleanup. The
    // retry must not use an identical name as ownership proof.
    world.set(worldKey(historicalScaffold!.position), "dirt");
    fake.bot.dig = fake.dig;

    const retry = await makeSkill().run({ jobId: job.id }, makeContext(fake.bot));

    expect(retry).toMatchObject({
      ok: false,
      code: "AREA_UNSAFE",
      details: expect.objectContaining({
        jobId: job.id,
        intendedScaffold: "dirt",
        observed: "dirt",
      }),
    });
    expect(fake.dig).not.toHaveBeenCalled();
    expect(fake.placeBlock).toHaveBeenCalledTimes(3);
    // Detection runs before opening another journal or verifying completion.
    expect(listTransactions(db, { serverKey: "test.example:25565" })).toHaveLength(1);
    expect(getConstructionJob(db, job.id)).toMatchObject({ status: "failed", placedCount: 1 });
  });

  it("does not block a historical support position after its cleanup was applied", async () => {
    const blueprint = upsertBlueprint(db, {
      name: "historical-scaffold-cleaned",
      blocks: [{ x: 0, y: 0, z: 0, block: "stone" }],
    });
    const job = createConstructionJob(db, {
      blueprintId: blueprint.id,
      originX: 0,
      originY: 65,
      originZ: 0,
    });
    const transactions = createWorldTransactionService({ db });
    const attempt = transactions.beginOrReuseConstructionAttempt({
      serverKey: "test.example:25565",
      dimension: "overworld",
      constructionJobId: job.id,
      actor,
      label: "old scaffold attempt",
    });
    const scaffoldPosition = { x: 1, y: 64, z: 0 };
    const placedScaffold = {
      action: "place" as const,
      position: scaffoldPosition,
      before: scaffoldSnapshot(scaffoldPosition, "air"),
      intended: { name: "dirt" },
    };
    const placedHooks = transactions.createConstructionMutationHooks({
      transactionId: attempt.id,
      ordinal: 8_192,
    });
    await placedHooks.planned?.(placedScaffold);
    await placedHooks.applied?.(placedScaffold);
    const cleanedScaffold = {
      action: "dig" as const,
      position: scaffoldPosition,
      before: scaffoldSnapshot(scaffoldPosition, "dirt"),
      intended: { name: "air" },
    };
    const cleanedHooks = transactions.createConstructionMutationHooks({
      transactionId: attempt.id,
      ordinal: 8_198,
    });
    await cleanedHooks.planned?.(cleanedScaffold);
    await cleanedHooks.applied?.(cleanedScaffold);

    // A later player dirt block at this coordinate is not an unresolved
    // SmartBot support after the recorded cleanup; it must not prevent an
    // otherwise matching blueprint from completing.
    const world = new Map<string, string>([
      ["0,65,0", "stone"],
      [worldKey(scaffoldPosition), "dirt"],
    ]);
    const fake = makeBot({ world, inventory: {} });

    const result = await makeSkill().run({ jobId: job.id }, makeContext(fake.bot));

    expect(result).toMatchObject({ ok: true, data: { placed: 0, total: 1 } });
    expect(fake.dig).not.toHaveBeenCalled();
    expect(fake.placeBlock).not.toHaveBeenCalled();
    expect(getConstructionJob(db, job.id)).toMatchObject({ status: "completed", placedCount: 1 });
  });

  it("repairs a replaceable target that disappears after primary postcondition verification", async () => {
    const blueprint = upsertBlueprint(db, {
      name: "repair-one-missing-target",
      blocks: [{ x: 0, y: 0, z: 0, block: "stone" }],
    });
    const job = createConstructionJob(db, {
      blueprintId: blueprint.id,
      originX: 0,
      originY: 65,
      originZ: 0,
    });
    const world = new Map<string, string>([["0,64,0", "stone"]]);
    let disappeared = false;
    const fake = makeBot({
      world,
      inventory: { stone: 2 },
      afterBlockRead: (position, name) => {
        // The object returned to the executor still says stone, so the
        // primary click is journal-confirmed. The next scan sees air and must
        // use its one bounded repair pass rather than completing early.
        if (!disappeared && name === "stone" && worldKey(position) === "0,65,0") {
          world.delete(worldKey(position));
          disappeared = true;
        }
      },
    });

    const result = await makeSkill().run({ jobId: job.id }, makeContext(fake.bot));

    expect(result).toMatchObject({
      ok: true,
      data: {
        total: 1,
        repaired: 1,
        verification: expect.objectContaining({
          matches: true,
          correct: 1,
          missing: 0,
          conflicting: 0,
          unloaded: 0,
          stateMismatched: 0,
        }),
      },
    });
    expect(disappeared).toBe(true);
    expect(fake.placeBlock).toHaveBeenCalledTimes(2);
    expect(world.get("0,65,0")).toBe("stone");
    expect(getConstructionJob(db, job.id)).toMatchObject({ status: "completed", placedCount: 1 });
    const transaction = getTransaction(
      db,
      listTransactions(db, { serverKey: "test.example:25565" })[0]!.id,
    )!;
    expect(transaction).toMatchObject({ status: "completed", requestedChangeCount: 2, appliedChangeCount: 2 });
    expect(transaction.changes).toEqual(expect.arrayContaining([
      expect.objectContaining({ action: "place", ordinal: 0, status: "applied" }),
      expect.objectContaining({ action: "place", ordinal: 4_096, status: "applied" }),
    ]));
  });

  it("reports exact final verification and progress when a repair click fails", async () => {
    const blueprint = upsertBlueprint(db, {
      name: "repair-click-failure",
      blocks: [{ x: 0, y: 0, z: 0, block: "stone" }],
    });
    const job = createConstructionJob(db, {
      blueprintId: blueprint.id,
      originX: 0,
      originY: 65,
      originZ: 0,
    });
    const world = new Map<string, string>([["0,64,0", "stone"]]);
    let disappeared = false;
    const fake = makeBot({
      world,
      inventory: { stone: 2 },
      failPlacementAt: 2,
      afterBlockRead: (position, name) => {
        if (!disappeared && name === "stone" && worldKey(position) === "0,65,0") {
          world.delete(worldKey(position));
          disappeared = true;
        }
      },
    });

    const result = await makeSkill().run({ jobId: job.id }, makeContext(fake.bot));

    // A failed repair cannot report only the click failure: its visible result
    // and durable progress must describe the final live world exactly.
    expect(result).toMatchObject({
      ok: false,
      code: "UNKNOWN",
      details: {
        repaired: 0,
        verification: expect.objectContaining({
          matches: false,
          correct: 0,
          missing: 1,
          conflicting: 0,
          unloaded: 0,
          stateMismatched: 0,
        }),
      },
    });
    expect(fake.placeBlock).toHaveBeenCalledTimes(2);
    expect(world.get("0,65,0")).toBeUndefined();
    expect(getConstructionJob(db, job.id)).toMatchObject({ status: "blocked", placedCount: 0 });
    const transaction = getTransaction(
      db,
      listTransactions(db, { serverKey: "test.example:25565" })[0]!.id,
    )!;
    expect(transaction).toMatchObject({ status: "partial", requestedChangeCount: 2, appliedChangeCount: 1 });
    expect(transaction.changes).toEqual(expect.arrayContaining([
      expect.objectContaining({ action: "place", ordinal: 0, status: "applied" }),
      expect.objectContaining({ action: "place", ordinal: 4_096, status: "failed" }),
    ]));
  });

  it("caps repair work before any repair click and preserves the exact missing count", async () => {
    const targetCount = MAX_BUILD_REPAIR_UNITS + 1;
    const blueprint = upsertBlueprint(db, {
      name: "repair-cap-no-extra-clicks",
      blocks: Array.from({ length: targetCount }, (_, x) => ({ x, y: 0, z: 0, block: "stone" })),
    });
    const job = createConstructionJob(db, {
      blueprintId: blueprint.id,
      originX: 0,
      originY: 65,
      originZ: 0,
    });
    const world = new Map<string, string>(
      Array.from({ length: targetCount }, (_, x) => [`${x},64,0`, "stone"] as const),
    );
    let disappearances = 0;
    const fake = makeBot({
      world,
      inventory: { stone: targetCount },
      afterBlockRead: (position, name) => {
        if (name === "stone" && position.y === 65 && position.x >= 0 && position.x < targetCount && position.z === 0) {
          world.delete(worldKey(position));
          disappearances++;
        }
      },
    });

    const result = await makeSkill().run({ jobId: job.id }, makeContext(fake.bot));

    expect(result).toMatchObject({
      ok: false,
      code: "STALE_STATE",
      details: {
        missing: targetCount,
        repairLimit: MAX_BUILD_REPAIR_UNITS,
      },
    });
    expect(disappearances).toBe(targetCount);
    // Exactly the primary work ran. A cap failure cannot enter a partial or
    // unbounded repair loop after it has already detected too many gaps.
    expect(fake.placeBlock).toHaveBeenCalledTimes(targetCount);
    expect(getConstructionJob(db, job.id)).toMatchObject({ status: "blocked", placedCount: 0 });
    const transaction = getTransaction(
      db,
      listTransactions(db, { serverKey: "test.example:25565" })[0]!.id,
    )!;
    expect(transaction).toMatchObject({
      status: "partial",
      requestedChangeCount: targetCount,
      appliedChangeCount: targetCount,
    });
  });

  it("executes a 4,096-cell row in bounded batches with a bounded result payload", async () => {
    const count = 4_096;
    // The larger source-backed registration path is the only durable route
    // that may contain all 4,096 compiler-vetted units.
    setPlayerRole(db, { username: actor.username, role: "operator", grantedBy: "owner" });
    const blueprint = registerCompiledBlueprint(db, {
      name: "four-thousand-ninety-six",
      blocks: Array.from({ length: count }, (_, x) => ({ x, y: 0, z: 0, block: "stone" })),
      sourceSchema: "smartbot.build/v1",
      targetVersion: "1.21.11",
      sourceJson: '{"schema":"smartbot.build/v1"}',
      sourceHash: "a".repeat(64),
      compileReportJson: '{"requiredAccess":"operator"}',
      creator: { username: "owner", role: "owner", source: "recovery" },
    });
    const job = createConstructionJob(db, {
      blueprintId: blueprint.id,
      originX: 0,
      originY: 65,
      originZ: 0,
    });
    const world = new Map<string, string>();
    for (let x = 0; x < count; x++) world.set(`${x},64,0`, "stone");
    const fake = makeBot({ world, inventory: { stone: count } });
    const reportProgress = vi.fn();

    const result = await makeSkill().run(
      { jobId: job.id },
      makeContext(fake.bot, { reportProgress }),
    );

    expect(result).toMatchObject({
      ok: true,
      data: {
        placed: count,
        total: count,
        placementUnitCount: count,
        expectedWorldCellCount: count,
      },
    });
    expect(fake.placeBlock).toHaveBeenCalledTimes(count);
    expect(getConstructionJob(db, job.id)).toMatchObject({ status: "completed", placedCount: count });
    // The builder reports at phase/batch boundaries, never once per cell.
    expect(reportProgress.mock.calls.length).toBeGreaterThan(0);
    expect(reportProgress.mock.calls.length).toBeLessThan(160);
    const data = result.data as { verification?: { issues?: unknown[] } };
    expect(data.verification?.issues?.length ?? 0).toBeLessThanOrEqual(32);
    expect(JSON.stringify(result).length).toBeLessThan(20_000);
    const transaction = listTransactions(db, { serverKey: "test.example:25565" });
    expect(transaction).toHaveLength(1);
    expect(transaction[0]).toMatchObject({ status: "completed", requestedChangeCount: count, appliedChangeCount: count });
  }, 60_000);
});
