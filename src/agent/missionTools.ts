import { z } from "zod";
import { missionDefinitionSchema } from "../missions/schema.js";
import type {
  MissionCompileError,
  MissionCompileReport,
} from "../missions/compiler.js";
import type {
  MissionService,
  MissionServiceError,
} from "../missions/service.js";
import type {
  MissionDefinitionDetail,
  MissionRunDetail,
} from "../missions/types.js";
import {
  snapshotExecutionActor,
  type ExecutionActor,
} from "../permissions/executionActor.js";
import type { ToolDef, ToolResult } from "./tools.js";

const MAX_MISSION_TOOL_ERRORS = 16;
const MAX_MISSION_TOOL_STEPS = 32;
const MAX_MISSION_TOOL_SOURCE_BYTES = 16 * 1024;

const definitionInput = missionDefinitionSchema.describe(
  "A strict smartbot.mission/v1 JSON MissionScript definition. It has only bounded skill, clear, and build steps.",
);

export const validateMissionSchema = z.object({ definition: definitionInput });
export const previewMissionSchema = z.object({ definition: definitionInput });
export const saveMissionSchema = z.object({
  definition: definitionInput,
  replace: z.boolean().optional().describe("Explicitly replace a saved mission with the same name."),
  enabled: z.boolean().optional(),
});
export const listMissionsSchema = z.object({
  enabled: z.boolean().optional(),
  limit: z.number().int().min(1).max(100).optional(),
});
export const getMissionSchema = z.object({ missionId: z.number().int().positive() });
export const runMissionSchema = z.object({
  definitionId: z.number().int().positive().optional(),
  definition: definitionInput.optional(),
});
export const getMissionRunSchema = z.object({ runId: z.number().int().positive() });
export const manageMissionRunSchema = z.object({
  runId: z.number().int().positive(),
  action: z.enum(["pause", "resume", "cancel"]),
});

export function createValidateMissionTool(
  service: MissionService,
  actorProvider: () => ExecutionActor,
): ToolDef<z.infer<typeof validateMissionSchema>> {
  return {
    name: "validateMission",
    policy: { minimumRole: "viewer", effect: "read", reversible: false, mission: "forbidden" },
    description: "Validate a strict MissionScript without saving it, creating tasks, or changing the world.",
    inputSchema: validateMissionSchema,
    handler: async ({ definition }) => compileToolResult(service.validate({
      definition,
      actor: snapshotExecutionActor(actorProvider()),
    }), "validated"),
  };
}

export function createPreviewMissionTool(
  service: MissionService,
  actorProvider: () => ExecutionActor,
): ToolDef<z.infer<typeof previewMissionSchema>> {
  return {
    name: "previewMission",
    policy: { minimumRole: "viewer", effect: "read", reversible: false, mission: "forbidden" },
    description:
      "Compile a MissionScript into bounded logical/expanded counts and build requirements without saving, scheduling, or world changes.",
    inputSchema: previewMissionSchema,
    handler: async ({ definition }) => {
      const result = service.preview({
        definition,
        actor: snapshotExecutionActor(actorProvider()),
      });
      if (!result.ok) return compileErrorsToolResult(result.errors, "previewed");
      return {
        ok: true,
        summary:
          `previewed mission '${result.value.compilation.report.name}' with ` +
          `${result.value.compilation.report.logicalStepCount} logical and ` +
          `${result.value.compilation.report.expandedStepCount} durable steps`,
        details: {
          ...compactReport(result.value.compilation.report),
          buildSites: result.value.buildSites,
        },
      };
    },
  };
}

export function createSaveMissionTool(
  service: MissionService,
  actorProvider: () => ExecutionActor,
): ToolDef<z.infer<typeof saveMissionSchema>> {
  return {
    name: "saveMission",
    policy: { minimumRole: "operator", effect: "administrative", reversible: false, mission: "forbidden" },
    description:
      "Validate and save a MissionScript definition. Replacing an existing name requires replace=true and does not alter prior runs.",
    inputSchema: saveMissionSchema,
    handler: async ({ definition, replace, enabled }) => {
      const result = service.save({
        definition,
        actor: snapshotExecutionActor(actorProvider()),
        ...(replace === undefined ? {} : { replace }),
        ...(enabled === undefined ? {} : { enabled }),
      });
      if (!result.ok) return serviceFailure(result.error);
      return {
        ok: true,
        summary: `saved mission '${result.value.name}' as ${result.value.id}`,
        details: compactDefinition(result.value),
      };
    },
  };
}

export function createListMissionsTool(
  service: MissionService,
): ToolDef<z.infer<typeof listMissionsSchema>> {
  return {
    name: "listMissions",
    policy: { minimumRole: "viewer", effect: "read", reversible: false, mission: "forbidden" },
    description: "List up to 100 saved MissionScript definitions without returning their full source JSON.",
    inputSchema: listMissionsSchema,
    handler: async ({ enabled, limit }) => {
      try {
        const missions = service.listDefinitions({
          ...(enabled === undefined ? {} : { enabled }),
          ...(limit === undefined ? {} : { limit }),
        });
        return {
          ok: true,
          summary: JSON.stringify({
            missions: missions.map((mission) => ({
              id: mission.id,
              name: mission.name,
              enabled: mission.enabled,
              sourceHash: mission.sourceHash,
              creator: mission.creator,
              tsUpdated: mission.tsUpdated,
            })),
            totalCount: missions.length,
          }),
        };
      } catch (error) {
        return { ok: false, summary: `could not list missions: ${errorMessage(error)}`, code: "INVALID_PARAMS", recoverable: false };
      }
    },
  };
}

export function createGetMissionTool(
  service: MissionService,
): ToolDef<z.infer<typeof getMissionSchema>> {
  return {
    name: "getMission",
    policy: { minimumRole: "viewer", effect: "read", reversible: false, mission: "forbidden" },
    description: "Read one saved mission's bounded metadata and logical-step summary; compact source is included only when small.",
    inputSchema: getMissionSchema,
    handler: async ({ missionId }) => {
      try {
        const mission = service.getDefinition(missionId);
        if (!mission) return { ok: false, summary: `no mission ${missionId}`, code: "NOT_CONFIGURED", recoverable: false };
        return { ok: true, summary: JSON.stringify(compactDefinition(mission)) };
      } catch (error) {
        return { ok: false, summary: `could not read mission ${missionId}: ${errorMessage(error)}`, code: "UNKNOWN", recoverable: false };
      }
    },
  };
}

export function createRunMissionTool(
  service: MissionService,
  actorProvider: () => ExecutionActor,
): ToolDef<z.infer<typeof runMissionSchema>> {
  return {
    name: "runMission",
    policy: { minimumRole: "operator", effect: "administrative", reversible: false, mission: "forbidden" },
    description:
      "Compile and atomically start a saved or inline MissionScript as one durable task plan. It does not create nested construction plans.",
    inputSchema: runMissionSchema,
    handler: async ({ definitionId, definition }) => {
      const result = service.run({
        ...(definitionId === undefined ? {} : { definitionId }),
        ...(definition === undefined ? {} : { definition }),
        actor: snapshotExecutionActor(actorProvider()),
      });
      if (!result.ok) return serviceFailure(result.error);
      return {
        ok: true,
        summary:
          `started mission run ${result.value.run.id} with task plan ${result.value.plan.id} ` +
          `(${result.value.report.expandedStepCount} durable steps)`,
        details: {
          run: compactRun(result.value.run),
          taskPlanId: result.value.plan.id,
          constructionJobIds: result.value.constructionJobIds,
          report: compactReport(result.value.report),
        },
      };
    },
  };
}

export function createGetMissionRunTool(
  service: MissionService,
): ToolDef<z.infer<typeof getMissionRunSchema>> {
  return {
    name: "getMissionRun",
    policy: { minimumRole: "viewer", effect: "read", reversible: false, mission: "forbidden" },
    description: "Read a mission run's durable status, plan, deadline, and bounded logical-step links.",
    inputSchema: getMissionRunSchema,
    handler: async ({ runId }) => {
      try {
        const run = service.getRun(runId);
        if (!run) return { ok: false, summary: `no mission run ${runId}`, code: "NOT_CONFIGURED", recoverable: false };
        return { ok: true, summary: JSON.stringify(compactRun(run)) };
      } catch (error) {
        return { ok: false, summary: `could not read mission run ${runId}: ${errorMessage(error)}`, code: "UNKNOWN", recoverable: false };
      }
    },
  };
}

export function createManageMissionRunTool(
  service: MissionService,
  actorProvider: () => ExecutionActor,
): ToolDef<z.infer<typeof manageMissionRunSchema>> {
  return {
    name: "manageMissionRun",
    policy: { minimumRole: "operator", effect: "administrative", reversible: false, mission: "forbidden" },
    description:
      "Pause, resume, or cancel a durable mission run. Resume rechecks the current requester against the immutable mission source.",
    inputSchema: manageMissionRunSchema,
    handler: async ({ runId, action }) => {
      const result = service.manageRun({
        runId,
        action,
        actor: snapshotExecutionActor(actorProvider()),
      });
      if (!result.ok) return serviceFailure(result.error);
      return {
        ok: true,
        summary: `${action}d mission run ${result.value.id}`,
        details: compactRun(result.value),
      };
    },
  };
}

function compileToolResult(
  result: ReturnType<MissionService["validate"]>,
  verb: string,
): ToolResult {
  if (!result.ok) return compileErrorsToolResult(result.errors, verb);
  return {
    ok: true,
    summary:
      `${verb} mission '${result.value.report.name}' with ${result.value.report.logicalStepCount} logical ` +
      `and ${result.value.report.expandedStepCount} durable steps`,
    details: compactReport(result.value.report),
  };
}

function compileErrorsToolResult(errors: readonly MissionCompileError[], verb: string): ToolResult {
  const bounded = errors.slice(0, MAX_MISSION_TOOL_ERRORS);
  const denied = bounded.some((error) =>
    error.code === "ROLE_DENIED" || error.code === "BUILD_ACCESS_DENIED" || error.code === "ACTOR_INVALID");
  return {
    ok: false,
    summary: `${verb} mission failed: ${bounded.map((error) => `${error.stepId ?? "mission"}: ${error.message}`).join("; ")}`,
    code: denied ? "PERMISSION_DENIED" : "INVALID_PARAMS",
    recoverable: false,
    details: { errorCount: errors.length, errors: bounded },
  };
}

function serviceFailure(error: MissionServiceError): ToolResult {
  const code = error.code === "PERMISSION_DENIED"
    ? "PERMISSION_DENIED"
    : error.code === "WORLD_UNAVAILABLE"
      ? "WORLD_UNAVAILABLE"
      : error.code === "NOT_FOUND"
        ? "NOT_CONFIGURED"
        : error.code === "INVALID_STATE"
          ? "TARGET_UNAVAILABLE"
          : error.code === "MISSION_INVALID"
            ? "INVALID_PARAMS"
            : "UNKNOWN";
  return {
    ok: false,
    summary: error.message,
    code,
    recoverable: error.code === "WORLD_UNAVAILABLE" || error.code === "INVALID_STATE",
    details: {
      serviceCode: error.code,
      ...(error.details ? { ...error.details } : {}),
      ...(error.compileErrors ? { errors: error.compileErrors.slice(0, MAX_MISSION_TOOL_ERRORS) } : {}),
    },
  };
}

function compactReport(report: MissionCompileReport): Record<string, unknown> {
  return {
    name: report.name,
    logicalStepCount: report.logicalStepCount,
    expandedStepCount: report.expandedStepCount,
    estimatedWorldChanges: report.estimatedWorldChanges,
    maxExpandedSteps: report.maxExpandedSteps,
    maxWorldChanges: report.maxWorldChanges,
    maxRuntimeMinutes: report.maxRuntimeMinutes,
    requiredRole: report.requiredRole,
    builds: report.builds.slice(0, MAX_MISSION_TOOL_STEPS),
    warnings: report.warnings.slice(0, MAX_MISSION_TOOL_ERRORS),
  };
}

function compactDefinition(definition: MissionDefinitionDetail): Record<string, unknown> {
  const bytes = Buffer.byteLength(definition.sourceJson, "utf8");
  return {
    id: definition.id,
    name: definition.name,
    enabled: definition.enabled,
    schema: definition.schema,
    sourceHash: definition.sourceHash,
    creator: definition.creator,
    tsCreated: definition.tsCreated,
    tsUpdated: definition.tsUpdated,
    limits: definition.definition.limits,
    steps: definition.definition.steps.slice(0, MAX_MISSION_TOOL_STEPS).map((step) => ({
      id: step.id,
      op: step.op,
      maxAttempts: step.maxAttempts,
      ...(step.op === "skill" ? { skill: step.skill } : {}),
      ...(step.op === "build"
        ? { blueprintName: "blueprintName" in step ? step.blueprintName : step.definition.name }
        : {}),
    })),
    sourceBytes: bytes,
    sourceTruncated: bytes > MAX_MISSION_TOOL_SOURCE_BYTES,
    ...(bytes <= MAX_MISSION_TOOL_SOURCE_BYTES ? { definition: definition.definition } : {}),
  };
}

function compactRun(run: MissionRunDetail): Record<string, unknown> {
  return {
    id: run.id,
    definitionId: run.definitionId,
    sourceHash: run.sourceHash,
    actor: run.actor,
    status: run.status,
    taskPlanId: run.taskPlanId,
    deadlineAt: run.deadlineAt,
    transactionScope: run.transactionScope,
    tsCreated: run.tsCreated,
    tsStarted: run.tsStarted,
    tsFinished: run.tsFinished,
    lastError: run.lastError,
    logicalSteps: run.stepLinks.slice(0, MAX_MISSION_TOOL_STEPS).map((link) => ({
      logicalStepId: link.logicalStepId,
      logicalPosition: link.logicalPosition,
      expandedStartPosition: link.expandedStartPosition,
      expandedStepCount: link.expandedStepCount,
      constructionJobId: link.constructionJobId,
      estimatedWorldChanges: link.compileMetadata.estimatedWorldChanges ?? null,
    })),
  };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
