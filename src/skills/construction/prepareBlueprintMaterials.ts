import { z } from "zod";
import type { DB } from "../../memory/db.js";
import {
  countExpectedWorldCells,
  countPlacementUnitMaterials,
  getBlueprint,
  getBlueprintSource,
  getConstructionJob,
  type BlueprintRow,
  type ConstructionJobRow,
} from "../../construction/store.js";
import { assertCurrentConstructionSourceAccess } from "../../construction/sourceAccess.js";
import { checkInventoryRequirements, createInventorySnapshot } from "../../inventory/snapshot.js";
import { countInInventory } from "../helpers.js";
import {
  defineSkill,
  type SkillContext,
  type SkillDefinition,
  type SkillResult,
} from "../types.js";
import { chopTrees } from "../resources/chopTrees.js";
import { mineUntil } from "../resources/mineUntil.js";
import { retrieveItem } from "../resources/retrieveItem.js";
import { craftItem } from "../items/craftItem.js";
import { smeltItem } from "../items/smeltItem.js";
import { ensureTool } from "../items/ensureTool.js";

const params = z.object({
  jobId: z.number().int().positive(),
});

interface PreparationSkills {
  chopTrees: typeof chopTrees;
  mineUntil: typeof mineUntil;
  craftItem: typeof craftItem;
  smeltItem: typeof smeltItem;
  ensureTool: typeof ensureTool;
  retrieveItem: ReturnType<typeof retrieveItem>;
}

/** Re-check dynamic source authority immediately before a delegated mutation. */
type MutationAuthorization = () => SkillResult | undefined;

export interface PrepareBlueprintMaterialsDependencies {
  readonly db: DB;
  /** Re-resolves durable source provenance at every material-execution boundary. */
  readonly ownerUsername: string;
  /** BuildOps sources may only run against this exact selected profile. */
  readonly configuredVersion: string;
  /** Read immediately before any delegated storage/gather/craft mutation. */
  readonly getLiveVersion: () => string | undefined;
}

/**
 * The material cost and world verification cardinality deliberately differ.
 * A verified future multi-cell placement (for example, one door item creating
 * two expected cells) consumes one `item`, while construction still compares
 * every expected world cell after placement.
 */
export interface BlueprintMaterialPlan {
  requirements: Map<string, number>;
  placementUnitCount: number;
  expectedWorldCellCount: number;
}

/**
 * Derive material requirements from inventory placement units, rather than
 * from the legacy flat cell list retained in `blocks_json`.
 */
export function planBlueprintMaterials(
  blueprint: Pick<BlueprintRow, "placementUnits">,
): BlueprintMaterialPlan {
  return {
    requirements: countPlacementUnitMaterials(blueprint.placementUnits),
    placementUnitCount: blueprint.placementUnits.length,
    expectedWorldCellCount: countExpectedWorldCells(blueprint.placementUnits),
  };
}

const DIRECT_MINE_BLOCKS: Record<string, { block: string; resultItem?: string }> = {
  cobblestone: { block: "stone", resultItem: "cobblestone" },
  dirt: { block: "dirt" },
  sand: { block: "sand" },
};

const AUTOMATIC_MATERIALS = new Set([
  "oak_log",
  "oak_planks",
  "oak_door",
  "cobblestone",
  "dirt",
  "sand",
  "glass",
]);

/**
 * Mission material preparation may withdraw explicitly indexed stock, but it
 * must never fan out into unjournaled gathering or crafting work. Keep the
 * diagnostic bounded even when a malformed/large blueprint has many material
 * kinds, since this result is retained by the durable task runner.
 */
const MAX_MISSION_MISSING_MATERIALS = 32;

export function prepareBlueprintMaterials(
  deps: PrepareBlueprintMaterialsDependencies,
  overrides: Partial<PreparationSkills> = {},
): SkillDefinition<z.infer<typeof params>> {
  const { db } = deps;
  const skills: PreparationSkills = {
    chopTrees,
    mineUntil,
    craftItem,
    smeltItem,
    ensureTool,
    retrieveItem: retrieveItem(db),
    ...overrides,
  };
  return defineSkill({
    name: "prepareBlueprintMaterials",
    policy: { minimumRole: "operator", effect: "world-change", reversible: false, mission: "internal" },
    description:
      "Prepare exact materials for a construction job. Retrieves indexed stock first, then " +
      "gathers common blocks, converts oak logs to planks and doors, and smelts glass.",
    params,
    longRunning: true,
    async run({ jobId }, ctx) {
      const job = getConstructionJob(db, jobId);
      if (!job) {
        return {
          ok: false,
          summary: `no construction job ${jobId}`,
          code: "NOT_CONFIGURED",
          recoverable: false,
          details: { jobId },
        };
      }
      if (!jobBelongsToExecution(job, ctx.execution.planId)) {
        return {
          ok: false,
          summary:
            `construction job ${jobId} is not owned by this execution context`,
          code: "TARGET_UNAVAILABLE",
          recoverable: true,
          details: {
            jobId,
            expectedPlanId: job.lastPlanId,
            ...(ctx.execution.planId === undefined
              ? { currentPlanId: null }
              : { currentPlanId: ctx.execution.planId }),
          },
        };
      }
      const dimension = ctx.bot.game?.dimension?.trim();
      if (!dimension) {
        return {
          ok: false,
          summary: "the current Minecraft dimension is unavailable; material preparation did not start",
          code: "WORLD_UNAVAILABLE",
          recoverable: true,
          details: { jobId, expectedDimension: job.dimension },
        };
      }
      if (dimension !== job.dimension) {
        return {
          ok: false,
          summary: `material preparation for job ${jobId} is in ${job.dimension} but bot is in ${dimension}`,
          code: "TARGET_UNAVAILABLE",
          recoverable: true,
          details: { jobId, expectedDimension: job.dimension, currentDimension: dimension },
        };
      }
      const blueprint = getBlueprint(db, job.blueprintId);
      if (!blueprint) {
        return {
          ok: false,
          summary: `construction job ${jobId} has no blueprint`,
          code: "NOT_CONFIGURED",
          recoverable: false,
          details: { jobId },
        };
      }

      const authorizeMutation: MutationAuthorization = () =>
        assertCurrentPreparationSourceAccess(deps, blueprint, ctx, jobId);
      const sourceAccessFailure = authorizeMutation();
      if (sourceAccessFailure) return sourceAccessFailure;

      const materialPlan = planBlueprintMaterials(blueprint);
      const { requirements } = materialPlan;
      ctx.reportProgress(
        `planning ${materialPlan.placementUnitCount} placement units across ` +
        `${materialPlan.expectedWorldCellCount} expected world cells`,
      );
      // A generated blueprint can legitimately use a block that this skill
      // cannot gather or craft itself. Carried stock and a configured
      // indexed-container path are still valid acquisition routes for any
      // registry item, so do not reject those materials until both are checked.
      if (job.storageName) {
        for (const [item, quantity] of requirements) {
          if (countInInventory(ctx.bot, item) >= quantity) continue;
          ctx.reportProgress(`checking ${job.storageName} for ${item}`);
          const authorization = authorizeMutation();
          if (authorization) return authorization;
          const result = await skills.retrieveItem.run({
            item,
            quantity,
            chestName: job.storageName,
            excludeChestName: undefined,
          }, ctx);
          if (!result.ok && result.code !== "NO_MATERIAL") {
            return annotate(result, jobId, "storage retrieval");
          }
        }
      }

      // A mission's declared world-change budget covers journaled execution
      // steps, not the legacy implicit acquisition fan-out below. It may use
      // carried items and a specifically configured indexed store, then must
      // stop before delegating to mining, tree chopping, crafting, smelting,
      // or tool preparation. Returning early when complete also makes this
      // guarantee robust against future additions to the ordinary path.
      if (ctx.execution.missionRunId !== undefined) {
        const missing = checkInventoryRequirements(
          createInventorySnapshot(ctx.bot),
          [...requirements].map(([item, quantity]) => ({ item, quantity })),
        ).filter((status) => !status.satisfied);
        if (missing.length > 0) {
          const visibleMissing = missing.slice(0, MAX_MISSION_MISSING_MATERIALS);
          return {
            ok: false,
            summary:
              "mission material preparation requires staged materials: " +
              visibleMissing.map((status) => `${status.missing} ${status.item}`).join(", ") +
              (missing.length > visibleMissing.length ? ", …" : ""),
            code: "NO_MATERIAL",
            recoverable: true,
            details: {
              jobId,
              missionRunId: ctx.execution.missionRunId,
              missing: visibleMissing,
              missingCount: missing.length,
              missingTruncated: missing.length > visibleMissing.length,
              placementUnitCount: materialPlan.placementUnitCount,
              expectedWorldCellCount: materialPlan.expectedWorldCellCount,
              guidance:
                "stage the remaining materials in inventory or the configured indexed storage, then resume",
            },
          };
        }
        return materialReadyResult(jobId, blueprint.name, materialPlan, requirements);
      }

      const unsupported = [...requirements]
        .filter(([item, quantity]) =>
          !AUTOMATIC_MATERIALS.has(item) && countInInventory(ctx.bot, item) < quantity)
        .map(([item]) => item);
      if (unsupported.length > 0) {
        return {
          ok: false,
          summary:
            `automatic preparation does not know how to obtain ${unsupported.join(", ")}`,
          code: "NO_MATERIAL",
          recoverable: true,
          details: {
            jobId,
            unsupported,
            requirements: Object.fromEntries(requirements),
            placementUnitCount: materialPlan.placementUnitCount,
            expectedWorldCellCount: materialPlan.expectedWorldCellCount,
            guidance: "put these blocks in inventory or an indexed storage container and resume",
          },
        };
      }

      const oakResult = await prepareOak(requirements, skills, ctx, jobId, authorizeMutation);
      if (oakResult) return oakResult;

      for (const item of ["cobblestone", "dirt"] as const) {
        const quantity = requirements.get(item) ?? 0;
        if (quantity <= countInInventory(ctx.bot, item)) continue;
        const source = DIRECT_MINE_BLOCKS[item]!;
        if (item === "cobblestone") {
          ctx.reportProgress("ensuring a pickaxe for stone");
          const toolAuthorization = authorizeMutation();
          if (toolAuthorization) return toolAuthorization;
          const toolResult = await skills.ensureTool.run({
            block: source.block,
            searchRadius: 64,
            craftingTableRadius: 16,
          }, ctx);
          if (!toolResult.ok) {
            return annotate(toolResult, jobId, "preparing a tool for cobblestone");
          }
        }
        ctx.reportProgress(`gathering ${item} to ${quantity}`);
        const mineAuthorization = authorizeMutation();
        if (mineAuthorization) return mineAuthorization;
        const result = await skills.mineUntil.run({
          block: source.block,
          resultItem: source.resultItem,
          quantity,
          searchRadius: 64,
        }, ctx);
        if (!result.ok) return annotate(result, jobId, `gathering ${item}`);
      }

      const glassResult = await prepareGlass(requirements, skills, ctx, jobId, authorizeMutation);
      if (glassResult) return glassResult;

      const finalStatuses = checkInventoryRequirements(
        createInventorySnapshot(ctx.bot),
        [...requirements].map(([item, quantity]) => ({ item, quantity })),
      );
      const missing = finalStatuses.filter((status) => !status.satisfied);
      if (missing.length > 0) {
        return {
          ok: false,
          summary:
            `material preparation incomplete: ` +
            missing.map((status) => `${status.missing} ${status.item}`).join(", "),
          code: "NO_MATERIAL",
          recoverable: true,
          details: {
            jobId,
            requirements: finalStatuses,
            placementUnitCount: materialPlan.placementUnitCount,
            expectedWorldCellCount: materialPlan.expectedWorldCellCount,
            guidance: "supply the remaining materials and resume construction",
          },
        };
      }
      return materialReadyResult(jobId, blueprint.name, materialPlan, requirements);
    },
  });
}

function materialReadyResult(
  jobId: number,
  blueprintName: string,
  materialPlan: BlueprintMaterialPlan,
  requirements: ReadonlyMap<string, number>,
): SkillResult {
  return {
    ok: true,
    summary:
      `materials ready for '${blueprintName}': ` +
      [...requirements].map(([item, quantity]) => `${quantity} ${item}`).join(", "),
    data: {
      jobId,
      blueprint: blueprintName,
      requirements: Object.fromEntries(requirements),
      placementUnitCount: materialPlan.placementUnitCount,
      expectedWorldCellCount: materialPlan.expectedWorldCellCount,
    },
  };
}

/**
 * Source-backed builds cannot let their preparation step become an indirect
 * privilege or version bypass. Raw/private blueprints intentionally avoid the
 * live-version provider altogether and retain their established path.
 */
function assertCurrentPreparationSourceAccess(
  deps: PrepareBlueprintMaterialsDependencies,
  blueprint: BlueprintRow,
  ctx: SkillContext,
  jobId: number,
): SkillResult | undefined {
  if (ctx.signal.aborted) {
    return {
      ok: false,
      summary: `material preparation for job ${jobId} was interrupted`,
      code: "INTERRUPTED",
      recoverable: true,
      details: { jobId },
    };
  }
  const currentJob = getConstructionJob(deps.db, jobId);
  if (!currentJob || !jobBelongsToExecution(currentJob, ctx.execution.planId)) {
    return {
      ok: false,
      summary: `construction job ${jobId} is not owned by this execution context`,
      code: "TARGET_UNAVAILABLE",
      recoverable: true,
      details: {
        jobId,
        expectedPlanId: currentJob?.lastPlanId ?? null,
        ...(ctx.execution.planId === undefined
          ? { currentPlanId: null }
          : { currentPlanId: ctx.execution.planId }),
      },
    };
  }
  // A task-engine preparation step runs while its linked job is `running`.
  // Direct preparation preserves the long-standing pending-job workflow, but
  // cannot continue after control-plane pause/cancel/block/completion.
  const directPending = ctx.execution.planId === undefined && currentJob.status === "pending";
  if (currentJob.status !== "running" && !directPending) {
    return {
      ok: false,
      summary: `construction job ${jobId} is ${currentJob.status} and material preparation is not active`,
      code: currentJob.status === "cancelled" ? "TARGET_UNAVAILABLE" : "INTERRUPTED",
      recoverable: currentJob.status !== "cancelled",
      details: {
        jobId,
        status: currentJob.status,
        ...(currentJob.lastPlanId === null ? { planId: null } : { planId: currentJob.lastPlanId }),
      },
    };
  }
  if (!getBlueprintSource(deps.db, blueprint.id)) return undefined;
  let liveVersion: string | undefined;
  try {
    liveVersion = deps.getLiveVersion();
  } catch (error) {
    return {
      ok: false,
      summary:
        `material preparation for job ${jobId} is not authorized: ` +
        `the live Minecraft version is unavailable (${errorMessage(error)})`,
      code: "PERMISSION_DENIED",
      recoverable: false,
      details: { jobId, blueprint: blueprint.name },
    };
  }
  if (liveVersion === undefined) {
    return {
      ok: false,
      summary:
        `material preparation for job ${jobId} is not authorized: ` +
        "the live Minecraft version is unavailable for this source-backed blueprint",
      code: "PERMISSION_DENIED",
      recoverable: false,
      details: { jobId, blueprint: blueprint.name },
    };
  }
  try {
    assertCurrentConstructionSourceAccess({
      db: deps.db,
      ownerUsername: deps.ownerUsername,
      blueprint,
      actor: ctx.execution.actor,
      configuredVersion: deps.configuredVersion,
      liveVersion,
    });
    return undefined;
  } catch (error) {
    return {
      ok: false,
      summary:
        `material preparation for job ${jobId} is no longer authorized: ${errorMessage(error)}`,
      code: "PERMISSION_DENIED",
      recoverable: false,
      details: { jobId, blueprint: blueprint.name },
    };
  }
}

async function prepareOak(
  requirements: Map<string, number>,
  skills: PreparationSkills,
  ctx: Parameters<typeof chopTrees.run>[1],
  jobId: number,
  authorizeMutation: MutationAuthorization,
): Promise<SkillResult | undefined> {
  const finalLogs = requirements.get("oak_log") ?? 0;
  const finalPlanks = requirements.get("oak_planks") ?? 0;
  const finalDoors = requirements.get("oak_door") ?? 0;
  const missingDoors = Math.max(0, finalDoors - countInInventory(ctx.bot, "oak_door"));
  const doorCrafts = Math.ceil(missingDoors / 3);
  const planksForDoors = doorCrafts * 6;
  const planksBeforeDoorCraft = finalPlanks + planksForDoors;
  const missingPlanks = Math.max(
    0,
    planksBeforeDoorCraft - countInInventory(ctx.bot, "oak_planks"),
  );
  const logsForPlanks = Math.ceil(missingPlanks / 4);
  const logsBeforeCraft = finalLogs + logsForPlanks;

  let treeAttempts = 0;
  while (countInInventory(ctx.bot, "oak_log") < logsBeforeCraft) {
    if (ctx.signal.aborted) {
      return {
        ok: false,
        summary: `material preparation for job ${jobId} cancelled`,
        code: "INTERRUPTED",
        recoverable: true,
        details: { jobId, stage: "gathering oak logs" },
      };
    }
    if (treeAttempts >= 16) {
      return {
        ok: false,
        summary:
          `still need ${logsBeforeCraft - countInInventory(ctx.bot, "oak_log")} oak_log ` +
          `after ${treeAttempts} tree attempts`,
        code: "NO_BLOCK_FOUND",
        recoverable: true,
        details: {
          jobId,
          stage: "gathering oak logs",
          required: logsBeforeCraft,
          current: countInInventory(ctx.bot, "oak_log"),
          guidance: "move near oak trees or put oak logs in indexed storage",
        },
      };
    }
    const before = countInInventory(ctx.bot, "oak_log");
    ctx.reportProgress(
      `gathering oak logs ${before}/${logsBeforeCraft}`,
    );
    const authorization = authorizeMutation();
    if (authorization) return authorization;
    const result = await skills.chopTrees.run({
      logType: "oak_log",
      count: 1,
      searchRadius: 64,
    }, ctx);
    if (!result.ok) return annotate(result, jobId, "gathering oak logs");
    treeAttempts++;
    if (countInInventory(ctx.bot, "oak_log") <= before) {
      return {
        ok: false,
        summary: "tree was chopped but no oak logs entered inventory",
        code: "NO_MATERIAL",
        recoverable: true,
        details: {
          jobId,
          stage: "gathering oak logs",
          guidance: "pick up nearby drops or free inventory space",
        },
      };
    }
  }

  if (countInInventory(ctx.bot, "oak_planks") < planksBeforeDoorCraft) {
    ctx.reportProgress(`crafting oak planks to ${planksBeforeDoorCraft}`);
    const result = await craftUntilTarget(
      skills,
      "oak_planks",
      planksBeforeDoorCraft,
      ctx,
      authorizeMutation,
    );
    if (result) return annotate(result, jobId, "crafting oak planks");
  }
  if (countInInventory(ctx.bot, "oak_door") < finalDoors) {
    ctx.reportProgress(`crafting oak doors to ${finalDoors}`);
    const result = await craftUntilTarget(
      skills,
      "oak_door",
      finalDoors,
      ctx,
      authorizeMutation,
    );
    if (result) return annotate(result, jobId, "crafting oak doors");
  }
  return undefined;
}

async function craftUntilTarget(
  skills: PreparationSkills,
  item: string,
  quantity: number,
  ctx: Parameters<typeof chopTrees.run>[1],
  authorizeMutation: MutationAuthorization,
): Promise<SkillResult | undefined> {
  let lastResult: SkillResult | undefined;
  for (let attempt = 1; attempt <= 4; attempt++) {
    const before = countInInventory(ctx.bot, item);
    if (before >= quantity) return undefined;
    const authorization = authorizeMutation();
    if (authorization) return authorization;
    lastResult = await skills.craftItem.run({
      item,
      quantity,
      craftingTableRadius: 16,
    }, ctx);
    const after = countInInventory(ctx.bot, item);
    if (after >= quantity) return undefined;
    if (ctx.signal.aborted || after <= before) return lastResult;
    ctx.reportProgress(
      `server completed a partial ${item} batch ${after}/${quantity}; retrying`,
    );
  }
  return lastResult ?? {
    ok: false,
    summary: `could not craft ${quantity} ${item}`,
    code: "NO_MATERIAL",
    recoverable: true,
  };
}

async function prepareGlass(
  requirements: Map<string, number>,
  skills: PreparationSkills,
  ctx: Parameters<typeof chopTrees.run>[1],
  jobId: number,
  authorizeMutation: MutationAuthorization,
): Promise<SkillResult | undefined> {
  const finalSand = requirements.get("sand") ?? 0;
  const finalGlass = requirements.get("glass") ?? 0;
  const missingGlass = Math.max(0, finalGlass - countInInventory(ctx.bot, "glass"));
  const sandBeforeSmelting = finalSand + missingGlass;
  if (countInInventory(ctx.bot, "sand") < sandBeforeSmelting) {
    const authorization = authorizeMutation();
    if (authorization) return authorization;
    const result = await skills.mineUntil.run({
      block: "sand",
      resultItem: "sand",
      quantity: sandBeforeSmelting,
      searchRadius: 64,
    }, ctx);
    if (!result.ok) return annotate(result, jobId, "gathering sand");
  }
  if (missingGlass === 0) return undefined;

  const fuelNeeded = Math.ceil(missingGlass / 8);
  if (countInInventory(ctx.bot, "coal") < fuelNeeded) {
    const toolAuthorization = authorizeMutation();
    if (toolAuthorization) return toolAuthorization;
    const toolResult = await skills.ensureTool.run({
      block: "coal_ore",
      searchRadius: 64,
      craftingTableRadius: 16,
    }, ctx);
    if (!toolResult.ok) {
      return annotate(toolResult, jobId, "preparing a tool for furnace fuel");
    }
    const mineAuthorization = authorizeMutation();
    if (mineAuthorization) return mineAuthorization;
    const result = await skills.mineUntil.run({
      block: "coal_ore",
      resultItem: "coal",
      quantity: fuelNeeded,
      searchRadius: 64,
    }, ctx);
    if (!result.ok) return annotate(result, jobId, "gathering furnace fuel");
  }
  const smeltAuthorization = authorizeMutation();
  if (smeltAuthorization) return smeltAuthorization;
  const result = await skills.smeltItem.run({
    input: "sand",
    output: "glass",
    quantity: finalGlass,
    fuel: "coal",
    furnaceRadius: 16,
  }, ctx);
  return result.ok ? undefined : annotate(result, jobId, "smelting glass");
}

/** A direct invocation is not allowed to piggyback a durable task plan. */
function jobBelongsToExecution(
  job: Pick<ConstructionJobRow, "lastPlanId">,
  planId: number | undefined,
): boolean {
  return job.lastPlanId === null
    ? planId === undefined
    : planId === job.lastPlanId;
}

function annotate(
  result: SkillResult,
  jobId: number,
  stage: string,
): SkillResult {
  return {
    ...result,
    summary: `${stage} failed: ${result.summary}`,
    details: { jobId, stage, ...result.details },
  };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
