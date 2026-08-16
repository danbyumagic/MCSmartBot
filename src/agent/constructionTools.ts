import { z } from "zod";
import type { Bot } from "mineflayer";
import type { ConstructionManager } from "../construction/manager.js";
import type {
  BuildOpsService,
  BuildOpsServiceError,
} from "../construction/buildOps/service.js";
import { buildSourceSchema } from "../construction/buildOps/schema.js";
import type { CompiledBuild } from "../construction/buildOps/types.js";
import { countPlacementUnitMaterials } from "../construction/store.js";
import {
  checkInventoryRequirements,
  createInventorySnapshot,
} from "../inventory/snapshot.js";
import {
  analyzeBuildSite,
  BUILD_ROTATIONS,
  findNearbyBuildSites,
  type BuildRotation,
} from "../construction/site.js";
import { UNSAFE_BLUEPRINT_BLOCKS } from "../skills/construction/buildBlueprint.js";
import type { ToolDef, ToolResult } from "./tools.js";
import {
  snapshotExecutionActor,
  type ExecutionActor,
} from "../permissions/executionActor.js";

// Raw relative-cell blueprints have no compiler report or durable source
// grant to authorize hazardous materials.  TNT is therefore accepted only by
// the BuildOps registration path, where the generated source carries a
// current owner requirement that construction rechecks before every click.
const UNSAFE_RAW_BLUEPRINT_BLOCKS = new Set([...UNSAFE_BLUEPRINT_BLOCKS, "tnt"]);

const blockSchema = z.object({
  x: z.number().int().min(-32).max(32),
  y: z.number().int().min(-32).max(32),
  z: z.number().int().min(-32).max(32),
  block: z.string().min(1).max(64),
});

const registerSchema = z.object({
  name: z.string().trim().min(1).max(120),
  blocks: z.array(blockSchema).min(1).max(256),
});

export function createRegisterBlueprintTool(
  manager: ConstructionManager,
): ToolDef<z.infer<typeof registerSchema>> {
  return {
    name: "registerBlueprint",
    policy: { minimumRole: "operator", effect: "world-change", reversible: false, mission: "forbidden" },
    description:
      "Save a bounded relative-coordinate building blueprint of at most 256 blocks. " +
      "Coordinates are offsets from the future build origin.",
    inputSchema: registerSchema,
    handler: async (input) => {
      const unsafe = input.blocks.find((entry) =>
        UNSAFE_RAW_BLUEPRINT_BLOCKS.has(entry.block.trim().toLowerCase()));
      if (unsafe) {
        return {
          ok: false,
          summary: `unsafe blueprint block '${unsafe.block}' is not allowed`,
          code: "AREA_UNSAFE",
          recoverable: false,
        };
      }
      try {
        const blueprint = manager.registerBlueprint(input);
        const materials = new Map<string, number>();
        for (const entry of blueprint.blocks) {
          materials.set(entry.block, (materials.get(entry.block) ?? 0) + 1);
        }
        return {
          ok: true,
          summary: `registered blueprint '${blueprint.name}' with ${blueprint.blocks.length} blocks ` +
            `materials=${JSON.stringify(Object.fromEntries(materials))}`,
        };
      } catch (err) {
        return {
          ok: false,
          summary: `could not register blueprint: ${(err as Error).message}`,
          code: "INVALID_PARAMS",
          recoverable: false,
        };
      }
    },
  };
}

const buildOriginSchema = z.object({
  x: z.number().int().min(-30_000_000).max(30_000_000),
  y: z.number().int().min(-64).max(320),
  z: z.number().int().min(-30_000_000).max(30_000_000),
}).strict();

const rotationSchema = z.union([
  z.literal(BUILD_ROTATIONS[0]),
  z.literal(BUILD_ROTATIONS[1]),
  z.literal(BUILD_ROTATIONS[2]),
  z.literal(BUILD_ROTATIONS[3]),
]);

/**
 * Keep the provider-visible input an object with one nested BuildOps union.
 * Both providers can represent the object shape; neither receives a JSON
 * string that would bypass Zod validation or auditability.
 */
export const previewBuildDefinitionSchema = z.object({
  definition: buildSourceSchema.describe("A compact smartbot.build/v1 or smartbot.build-ascii/v1 definition object."),
  origin: buildOriginSchema.optional().describe("Optional proposed world origin for a live site preview."),
  rotation: rotationSchema.optional().describe("Optional clockwise construction rotation: 0, 90, 180, or 270."),
});

export const registerBuildDefinitionSchema = z.object({
  definition: buildSourceSchema.describe("A compact smartbot.build/v1 or smartbot.build-ascii/v1 definition object."),
  name: z.string().trim().min(1).max(120).optional().describe("Optional saved blueprint name; defaults to definition.name."),
});

const MAX_BUILD_REPORT_SAMPLES = 32;
const MAX_BLUEPRINT_LIST_RESULTS = 64;

/** Preview a compact build source without database writes, tasks, or world mutation. */
export function createPreviewBuildDefinitionTool(
  service: BuildOpsService,
  bot: Bot | undefined,
): ToolDef<z.infer<typeof previewBuildDefinitionSchema>> {
  return {
    name: "previewBuildDefinition",
    policy: { minimumRole: "operator", effect: "read", reversible: false, mission: "forbidden" },
    description:
      "Compile a compact BuildOps or palette-ASCII definition without saving or building it. " +
      "Optionally inspect a proposed origin and rotation when the bot is connected.",
    inputSchema: previewBuildDefinitionSchema,
    handler: async (input) => {
      const result = service.previewBuildDefinition({ definition: input.definition });
      if (!result.ok) return buildOpsFailure(result.error);
      const compiled = result.value;
      const rotation = (input.rotation ?? 0) as BuildRotation;
      const site = input.origin
        ? previewBuildSite(bot, compiled, input.origin, rotation)
        : null;
      return {
        ok: true,
        summary:
          `previewed '${compiled.name}' with ${compiled.report.placementCount} placement cells ` +
          `for Minecraft ${compiled.targetVersion}`,
        details: {
          build: compactBuildReport(compiled),
          site,
        },
      };
    },
  };
}

/** Compile and atomically persist a source-backed blueprint under the current actor. */
export function createRegisterBuildDefinitionTool(
  service: BuildOpsService,
  actorProvider: () => ExecutionActor,
): ToolDef<z.infer<typeof registerBuildDefinitionSchema>> {
  return {
    name: "registerBuildDefinition",
    policy: { minimumRole: "operator", effect: "world-change", reversible: false, mission: "forbidden" },
    description:
      "Compile and save a compact BuildOps or palette-ASCII definition as a source-backed blueprint. " +
      "The exact selected Minecraft version is required; this action does not start construction.",
    inputSchema: registerBuildDefinitionSchema,
    handler: async (input) => {
      const result = service.registerBuildDefinition({
        definition: input.definition,
        creator: snapshotExecutionActor(actorProvider()),
        ...(input.name ? { name: input.name } : {}),
      });
      if (!result.ok) return buildOpsFailure(result.error);
      const { blueprint, compiled } = result.value;
      return {
        ok: true,
        summary:
          `registered generated blueprint '${blueprint.name}' with ${compiled.report.placementCount} placement cells`,
        details: {
          blueprint: {
            id: blueprint.id,
            name: blueprint.name,
            blockCount: blueprint.blocks.length,
          },
          build: compactBuildReport(compiled),
        },
      };
    },
  };
}

const getBlueprintSchema = z.object({
  name: z.string().trim().min(1).max(120),
});

export function createGetBlueprintTool(
  manager: ConstructionManager,
): ToolDef<z.infer<typeof getBlueprintSchema>> {
  return {
    name: "getBlueprint",
    policy: { minimumRole: "viewer", effect: "read", reversible: false, mission: "forbidden" },
    description:
      "Read bounded saved-blueprint metadata, source audit details, material totals, and up to 32 placement samples. " +
      "Large compiled placement lists remain internal to construction execution.",
    inputSchema: getBlueprintSchema,
    handler: async ({ name }) => {
      const blueprint = manager.getBlueprint(name);
      if (!blueprint) {
        return {
          ok: false, summary: `no blueprint named '${name}'`,
          code: "NOT_CONFIGURED", recoverable: false,
        };
      }
      return {
        ok: true,
        summary: JSON.stringify(blueprint),
      };
    },
  };
}

const listBlueprintsSchema = z.object({});

export function createListBlueprintsTool(
  manager: ConstructionManager,
): ToolDef<z.infer<typeof listBlueprintsSchema>> {
  return {
    name: "listBlueprints",
    policy: { minimumRole: "viewer", effect: "read", reversible: false, mission: "forbidden" },
    description:
      "List saved and built-in construction blueprints with dimensions, block counts, and material totals.",
    inputSchema: listBlueprintsSchema,
    handler: async () => {
      const blueprints = manager.listBlueprints();
      if (blueprints.length === 0) {
        return { ok: true, summary: "no blueprints registered" };
      }
      return {
        ok: true,
        summary: JSON.stringify({
          blueprints: blueprints.slice(0, MAX_BLUEPRINT_LIST_RESULTS),
          totalCount: blueprints.length,
          truncated: blueprints.length > MAX_BLUEPRINT_LIST_RESULTS,
        }),
      };
    },
  };
}

const startSchema = z.object({
  blueprintName: z.string().trim().min(1).max(120),
  dimension: z.string().min(1).max(64).default("overworld"),
  originX: z.number().int().min(-30_000_000).max(30_000_000),
  originY: z.number().int().min(-64).max(320),
  originZ: z.number().int().min(-30_000_000).max(30_000_000),
  rotation: z
    .union([
      z.literal(BUILD_ROTATIONS[0]),
      z.literal(BUILD_ROTATIONS[1]),
      z.literal(BUILD_ROTATIONS[2]),
      z.literal(BUILD_ROTATIONS[3]),
    ])
    .optional()
    .describe("Clockwise blueprint rotation in degrees: 0, 90, 180, or 270."),
  autoAdjustSite: z
    .boolean()
    .optional()
    .describe(
      "When true (default), move the origin up to 4 blocks to the nearest safe flat site.",
    ),
  storageName: z.string().min(1).max(64).optional(),
});

export function createStartConstructionTool(
  manager: ConstructionManager,
  bot: Bot | undefined,
  actorProvider: () => ExecutionActor,
): ToolDef<z.infer<typeof startSchema>> {
  return {
    name: "startConstruction",
    policy: { minimumRole: "operator", effect: "world-change", reversible: false, mission: "forbidden" },
    description:
      "Inspect and start a durable build of a registered blueprint. Supports 0/90/180/270 " +
      "degree rotation, finds a nearby safe flat origin when the requested site is blocked, " +
      "and schedules automatic material preparation before verified placement.",
    inputSchema: startSchema,
    handler: async (input) => {
      try {
        const actor = snapshotExecutionActor(actorProvider());
        let materialStatus: ReturnType<typeof checkInventoryRequirements> = [];
        const rotation = (input.rotation ?? 0) as BuildRotation;
        let origin = {
          originX: input.originX,
          originY: input.originY,
          originZ: input.originZ,
        };
        let adjustedFrom: typeof origin | undefined;
        let siteAnalysis: ReturnType<typeof analyzeBuildSite> | undefined;
        if (bot) {
          const blueprint = manager.getBlueprintForExecution(input.blueprintName);
          if (!blueprint) {
            return {
              ok: false,
              summary: `could not start construction: no blueprint named '${input.blueprintName}'`,
              code: "NOT_CONFIGURED",
              recoverable: false,
            };
          }
          // Execution and live verification operate on placement units, not
          // merely flat block names. In particular, source-backed stair hints
          // must reach the site check before a job can enqueue preparation.
          siteAnalysis = analyzeBuildSite(bot, blueprint.placementUnits, origin, rotation);
          if (!siteAnalysis.safe) {
            const alternatives = findNearbyBuildSites(
              bot,
              blueprint.placementUnits,
              origin,
              rotation,
            );
            if (input.autoAdjustSite !== false && alternatives.length > 0) {
              adjustedFrom = origin;
              const selected = alternatives[0]!;
              origin = {
                originX: selected.originX,
                originY: selected.originY,
                originZ: selected.originZ,
              };
              siteAnalysis = analyzeBuildSite(
                bot,
                blueprint.placementUnits,
                origin,
                rotation,
              );
            } else {
              const issueTotal = Object.values(siteAnalysis.issueCounts)
                .reduce((total, count) => total + count, 0);
              const unloaded = siteAnalysis.issueCounts.unloaded > 0;
              return {
                ok: false,
                summary:
                  `cannot start '${input.blueprintName}' at ` +
                  `${input.originX},${input.originY},${input.originZ}: ` +
                  `${issueTotal} blocked unsupported or unloaded positions`,
                code: unloaded ? "WORLD_UNAVAILABLE" : "AREA_UNSAFE",
                recoverable: true,
                details: {
                  blueprint: input.blueprintName,
                  rotation,
                  issues: siteAnalysis.issues.slice(0, 12),
                  issueCounts: siteAnalysis.issueCounts,
                  placementUnitCount: siteAnalysis.placementUnitCount,
                  worldCellCount: siteAnalysis.worldCellCount,
                  suggestedOrigins: alternatives,
                  guidance: alternatives.length > 0
                    ? "approve one of the nearby safe origins or retry with autoAdjustSite enabled"
                    : "choose a flatter clear site and inspect it again",
                },
              };
            }
          }
          const totals = countPlacementUnitMaterials(blueprint.placementUnits);
          materialStatus = checkInventoryRequirements(
            createInventorySnapshot(bot),
            [...totals].map(([item, quantity]) => ({ item, quantity })),
          );
        }
        const job = manager.startBuild({
          blueprintName: input.blueprintName,
          dimension: input.dimension,
          ...origin,
          storageName: input.storageName,
          rotation,
          actor,
        });
        const shortages = materialStatus.filter((status) => !status.satisfied);
        return {
          ok: true,
          summary: `started construction job ${job.id} for '${job.blueprintName}' ` +
            `with task plan ${job.lastPlanId} at ` +
            `${job.originX},${job.originY},${job.originZ} rotation=${rotation}` +
            (adjustedFrom
              ? ` (adjusted from ${adjustedFrom.originX},${adjustedFrom.originY},${adjustedFrom.originZ})`
              : "") +
            (shortages.length > 0
              ? `; preparation must supply ` +
                shortages.map((status) => `${status.missing} ${status.item}`).join(", ")
              : ""),
          details: {
            requirements: materialStatus,
            inventoryReady: shortages.length === 0,
            rotation,
            origin,
            adjustedFrom: adjustedFrom ?? null,
            site: siteAnalysis ?? null,
          },
        };
      } catch (err) {
        return {
          ok: false,
          summary: `could not start construction: ${(err as Error).message}`,
          code: "NOT_CONFIGURED",
          recoverable: false,
        };
      }
    },
  };
}

const getConstructionSchema = z.object({
  jobId: z.number().int().positive(),
});

export function createGetConstructionTool(
  manager: ConstructionManager,
): ToolDef<z.infer<typeof getConstructionSchema>> {
  return {
    name: "getConstruction",
    policy: { minimumRole: "viewer", effect: "read", reversible: false, mission: "forbidden" },
    description: "Read construction progress, origin, status, and latest durable task plan.",
    inputSchema: getConstructionSchema,
    handler: async ({ jobId }) => {
      const job = manager.getBuild(jobId);
      if (!job) {
        return {
          ok: false, summary: `no construction job ${jobId}`,
          code: "NOT_CONFIGURED", recoverable: false,
        };
      }
      return {
        ok: true,
        summary: JSON.stringify({
          id: job.id,
          blueprint: job.blueprintName,
          status: job.status,
          dimension: job.dimension,
          origin: [job.originX, job.originY, job.originZ],
          rotation: job.rotation,
          storageName: job.storageName,
          placedCount: job.placedCount,
          totalCount: job.totalCount,
          lastPlanId: job.lastPlanId,
          lastError: job.lastError,
        }),
      };
    },
  };
}

const manageSchema = z.object({
  jobId: z.number().int().positive(),
  action: z.enum(["pause", "resume", "cancel"]),
});

export function createManageConstructionTool(
  manager: ConstructionManager,
  actorProvider: () => ExecutionActor,
): ToolDef<z.infer<typeof manageSchema>> {
  return {
    name: "manageConstruction",
    policy: { minimumRole: "operator", effect: "administrative", reversible: false, mission: "forbidden" },
    description:
      "Pause, resume, or cancel a construction job. Resume reuses correct blocks and " +
      "creates a fresh durable plan when a prior attempt was blocked or failed.",
    inputSchema: manageSchema,
    handler: async ({ jobId, action }) => {
      // Snapshot the requester at the administrative boundary. In particular,
      // resume must never inherit a paused plan's former owner provenance.
      const actor = snapshotExecutionActor(actorProvider());
      if (!manager.manageBuild(jobId, action, actor)) {
        return {
          ok: false,
          summary: `could not ${action} construction job ${jobId} from its current state`,
          code: "TARGET_UNAVAILABLE",
          recoverable: false,
        };
      }
      return { ok: true, summary: `${action}d construction job ${jobId}` };
    },
  };
}

function compactBuildReport(compiled: CompiledBuild): Record<string, unknown> {
  const report = compiled.report;
  return {
    schema: compiled.schema,
    name: compiled.name,
    targetVersion: compiled.targetVersion,
    operationCount: report.operationCount,
    placementCount: report.placementCount,
    worldCellCount: report.worldCellCount,
    bounds: {
      min: [...report.bounds.min],
      max: [...report.bounds.max],
    },
    materials: { ...report.materials },
    overwrites: report.overwrites,
    punches: report.punches,
    requiredAccess: report.requiredAccess,
    sourceHash: report.sourceHash,
    warnings: report.warnings.slice(0, MAX_BUILD_REPORT_SAMPLES),
    diagnostics: report.diagnostics.slice(0, MAX_BUILD_REPORT_SAMPLES),
  };
}

function previewBuildSite(
  bot: Bot | undefined,
  compiled: CompiledBuild,
  origin: { x: number; y: number; z: number },
  rotation: BuildRotation,
): Record<string, unknown> {
  if (!bot) {
    return {
      available: false,
      reason: "bot is not connected; structural preview completed without a live site check",
      origin,
      rotation,
    };
  }
  const analysis = analyzeBuildSite(
    bot,
    compiled.placements,
    { originX: origin.x, originY: origin.y, originZ: origin.z },
    rotation,
    { maxIssueSamples: MAX_BUILD_REPORT_SAMPLES },
  );
  const issueCount = Object.values(analysis.issueCounts)
    .reduce((total, count) => total + count, 0);
  return {
    available: true,
    origin,
    rotation,
    safe: analysis.safe,
    correct: analysis.correct,
    pending: analysis.pending,
    placementUnitCount: analysis.placementUnitCount,
    worldCellCount: analysis.worldCellCount,
    correctPlacementUnits: analysis.correctPlacementUnits,
    pendingPlacementUnits: analysis.pendingPlacementUnits,
    issueCount,
    issueCounts: { ...analysis.issueCounts },
    issues: analysis.issues,
    truncated: issueCount > analysis.issues.length,
  };
}

function buildOpsFailure(error: BuildOpsServiceError): ToolResult {
  const code = (() => {
    switch (error.code) {
      case "ACCESS_DENIED":
        return "PERMISSION_DENIED" as const;
      case "VERSION_MISMATCH":
      case "PLACEMENT_HINT_UNSUPPORTED":
      case "UNSUPPORTED_EXECUTION":
        return "NOT_CONFIGURED" as const;
      case "PERSISTENCE_FAILED":
        return "UNKNOWN" as const;
      default:
        return "INVALID_PARAMS" as const;
    }
  })();
  return {
    ok: false,
    summary: `could not process BuildOps definition: ${error.message}`,
    code,
    recoverable: false,
    details: {
      buildOpsCode: error.code,
      ...(error.details ? { ...error.details } : {}),
    },
  };
}
