import { z } from "zod";
import type { SupplyScheduler } from "../supply/scheduler.js";
import type { ToolDef } from "./tools.js";

const createSchema = z.object({
  chestName: z.string().min(1).max(64),
  item: z.string().min(1).max(64),
  quantity: z.number().int().min(1).max(4096),
  searchRadius: z.number().int().min(8).max(128).default(64),
  intervalMinutes: z.number().int().min(1).max(1440).default(15),
});

export function createStandingSupplyGoalTool(
  scheduler: SupplyScheduler,
): ToolDef<z.infer<typeof createSchema>> {
  return {
    name: "createSupplyGoal",
    policy: { minimumRole: "operator", effect: "administrative", reversible: false, mission: "forbidden" },
    description:
      "Create a persistent standing goal that periodically verifies and replenishes an indexed container.",
    inputSchema: createSchema,
    handler: async ({ chestName, item, quantity, searchRadius, intervalMinutes }) => {
      const goal = scheduler.create({
        containerName: chestName,
        item,
        targetQuantity: quantity,
        searchRadius,
        intervalMinutes,
      });
      return {
        ok: true,
        summary: `created supply goal ${goal.id}: keep '${chestName}' at ${quantity} ${item}`,
      };
    },
  };
}

const getSchema = z.object({
  goalId: z.number().int().positive(),
});

export function createGetSupplyGoalTool(
  scheduler: SupplyScheduler,
): ToolDef<z.infer<typeof getSchema>> {
  return {
    name: "getSupplyGoal",
    policy: { minimumRole: "viewer", effect: "read", reversible: false, mission: "forbidden" },
    description: "Read the state of a persistent standing container-supply goal.",
    inputSchema: getSchema,
    handler: async ({ goalId }) => {
      const goal = scheduler.get(goalId);
      if (!goal) {
        return {
          ok: false, summary: `no supply goal ${goalId}`,
          code: "NOT_CONFIGURED", recoverable: false,
        };
      }
      return {
        ok: true,
        summary: JSON.stringify({
          id: goal.id,
          status: goal.status,
          chestName: goal.containerName,
          item: goal.item,
          quantity: goal.targetQuantity,
          intervalMinutes: goal.intervalMinutes,
          nextCheckAt: goal.nextCheckAt,
          lastPlanId: goal.lastPlanId,
          lastError: goal.lastError,
        }),
      };
    },
  };
}

const manageSchema = z.object({
  goalId: z.number().int().positive(),
  action: z.enum(["pause", "resume", "cancel"]),
});

export function createManageSupplyGoalTool(
  scheduler: SupplyScheduler,
): ToolDef<z.infer<typeof manageSchema>> {
  return {
    name: "manageSupplyGoal",
    policy: { minimumRole: "operator", effect: "administrative", reversible: false, mission: "forbidden" },
    description: "Pause, resume, or cancel a standing container-supply goal.",
    inputSchema: manageSchema,
    handler: async ({ goalId, action }) => {
      const status = action === "resume" ? "active" : action === "pause" ? "paused" : "cancelled";
      if (!scheduler.setStatus(goalId, status)) {
        return {
          ok: false,
          summary: `could not ${action} supply goal ${goalId}`,
          code: "TARGET_UNAVAILABLE",
          recoverable: false,
        };
      }
      return { ok: true, summary: `${action}d supply goal ${goalId}` };
    },
  };
}
