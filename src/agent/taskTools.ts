import { z } from "zod";
import {
  TaskPlanAuthorizationError,
  type TaskEngine,
} from "../tasks/engine.js";
import type { ToolDef } from "./tools.js";
import {
  snapshotExecutionActor,
  type ExecutionActor,
} from "../permissions/executionActor.js";

const createPlanSchema = z.object({
  title: z.string().min(1).max(160),
  steps: z.array(z.object({
    skill: z.string().min(1).max(64),
    params: z.record(z.unknown()).default({}),
    maxAttempts: z.number().int().min(1).max(10).default(3),
  })).min(1).max(32),
});

export function createTaskPlanTool(
  engine: TaskEngine,
  actorProvider: () => ExecutionActor,
): ToolDef<z.infer<typeof createPlanSchema>> {
  return {
    name: "createTaskPlan",
    policy: { minimumRole: "operator", effect: "administrative", reversible: false, mission: "forbidden" },
    description:
      "Create and immediately start a durable ordered plan of registered skills. " +
      "Use for multi-step work that must retry and survive restarts.",
    inputSchema: createPlanSchema,
    handler: async ({ title, steps }) => {
      try {
        const actor = snapshotExecutionActor(actorProvider());
        const plan = engine.create({ title, steps, actor });
        return {
          ok: true,
          summary: `created task plan ${plan.id} '${plan.title}' with ${plan.steps.length} steps`,
        };
      } catch (err) {
        if (err instanceof TaskPlanAuthorizationError) {
          return {
            ok: false,
            summary: `could not create task plan: ${err.message}`,
            code: "PERMISSION_DENIED",
            recoverable: false,
            details: err.details,
          };
        }
        return {
          ok: false,
          summary: `could not create task plan: ${(err as Error).message}`,
          code: "INVALID_PARAMS",
          recoverable: false,
        };
      }
    },
  };
}

const getPlanSchema = z.object({
  planId: z.number().int().positive(),
});

export function createGetTaskPlanTool(
  engine: TaskEngine,
): ToolDef<z.infer<typeof getPlanSchema>> {
  return {
    name: "getTaskPlan",
    policy: { minimumRole: "viewer", effect: "read", reversible: false, mission: "forbidden" },
    description: "Read a durable task plan and the status of each ordered step.",
    inputSchema: getPlanSchema,
    handler: async ({ planId }) => {
      const plan = engine.get(planId);
      if (!plan) {
        return {
          ok: false,
          summary: `no task plan ${planId}`,
          code: "NOT_CONFIGURED",
          recoverable: false,
        };
      }
      return {
        ok: true,
        summary: JSON.stringify({
          id: plan.id,
          title: plan.title,
          status: plan.status,
          lastError: plan.lastError,
          steps: plan.steps.map((step) => ({
            position: step.position,
            skill: step.skill,
            status: step.status,
            attempts: step.attempts,
            maxAttempts: step.maxAttempts,
            lastErrorCode: step.lastErrorCode,
            lastError: step.lastError,
          })),
        }),
      };
    },
  };
}

const managePlanSchema = z.object({
  planId: z.number().int().positive(),
  action: z.enum(["pause", "resume", "cancel"]),
});

export function createManageTaskPlanTool(
  engine: TaskEngine,
): ToolDef<z.infer<typeof managePlanSchema>> {
  return {
    name: "manageTaskPlan",
    policy: { minimumRole: "operator", effect: "administrative", reversible: false, mission: "forbidden" },
    description: "Pause, resume, or cancel a durable task plan.",
    inputSchema: managePlanSchema,
    handler: async ({ planId, action }) => {
      const changed =
        action === "pause" ? engine.pause(planId)
          : action === "resume" ? engine.resume(planId)
            : engine.cancel(planId);
      if (!changed) {
        return {
          ok: false,
          summary: `could not ${action} task plan ${planId} from its current state`,
          code: "TARGET_UNAVAILABLE",
          recoverable: false,
        };
      }
      return { ok: true, summary: `${action}d task plan ${planId}` };
    },
  };
}
