import { z } from "zod";
import type { FarmScheduler } from "../farming/scheduler.js";
import { FARM_CROPS } from "../farming/store.js";
import type { ToolDef } from "./tools.js";

const registerSchema = z.object({
  name: z.string().min(1).max(64),
  dimension: z.string().min(1).max(64).default("overworld"),
  minX: z.number().int().min(-30_000_000).max(30_000_000),
  minY: z.number().int().min(-64).max(320),
  minZ: z.number().int().min(-30_000_000).max(30_000_000),
  maxX: z.number().int().min(-30_000_000).max(30_000_000),
  maxY: z.number().int().min(-64).max(320),
  maxZ: z.number().int().min(-30_000_000).max(30_000_000),
  crop: z.enum(FARM_CROPS),
  storageName: z.string().min(1).max(64).optional(),
  seedReserve: z.number().int().min(1).max(256).default(16),
  intervalMinutes: z.number().int().min(1).max(1440).default(15),
});

function boundaryVolume(value: z.infer<typeof registerSchema>): number {
  return (
    (Math.abs(value.maxX - value.minX) + 1) *
    (Math.abs(value.maxY - value.minY) + 1) *
    (Math.abs(value.maxZ - value.minZ) + 1)
  );
}

export function createRegisterFarmTool(
  scheduler: FarmScheduler,
): ToolDef<z.infer<typeof registerSchema>> {
  return {
    name: "registerFarm",
    policy: { minimumRole: "operator", effect: "world-change", reversible: false, mission: "forbidden" },
    description:
      "Create or update a bounded crop farm and start periodic harvest/replant maintenance. " +
      "Inspect coordinates first and keep the boundary tight around the farm.",
    inputSchema: registerSchema,
    handler: async (input) => {
      if (boundaryVolume(input) > 4096) {
        return {
          ok: false,
          summary: "farm boundary volume must be at most 4096 blocks",
          code: "INVALID_PARAMS",
          recoverable: false,
          details: { volume: boundaryVolume(input), maxVolume: 4096 },
        };
      }
      const farm = scheduler.register(input);
      return {
        ok: true,
        summary: `registered farm ${farm.id} '${farm.name}' for ${farm.crop}`,
      };
    },
  };
}

const getSchema = z.object({ farmId: z.number().int().positive() });

export function createGetFarmTool(
  scheduler: FarmScheduler,
): ToolDef<z.infer<typeof getSchema>> {
  return {
    name: "getFarm",
    policy: { minimumRole: "viewer", effect: "read", reversible: false, mission: "forbidden" },
    description: "Read a registered farm, its exact boundary, schedule, and latest result.",
    inputSchema: getSchema,
    handler: async ({ farmId }) => {
      const farm = scheduler.get(farmId);
      if (!farm) {
        return {
          ok: false, summary: `no farm ${farmId}`,
          code: "NOT_CONFIGURED", recoverable: false,
        };
      }
      return {
        ok: true,
        summary: JSON.stringify({
          id: farm.id,
          name: farm.name,
          status: farm.status,
          crop: farm.crop,
          bounds: {
            min: [farm.minX, farm.minY, farm.minZ],
            max: [farm.maxX, farm.maxY, farm.maxZ],
          },
          storageName: farm.storageName,
          seedReserve: farm.seedReserve,
          intervalMinutes: farm.intervalMinutes,
          nextCheckAt: farm.nextCheckAt,
          lastPlanId: farm.lastPlanId,
          lastError: farm.lastError,
        }),
      };
    },
  };
}

const manageSchema = z.object({
  farmId: z.number().int().positive(),
  action: z.enum(["pause", "resume", "cancel"]),
});

export function createManageFarmTool(
  scheduler: FarmScheduler,
): ToolDef<z.infer<typeof manageSchema>> {
  return {
    name: "manageFarm",
    policy: { minimumRole: "operator", effect: "administrative", reversible: false, mission: "forbidden" },
    description: "Pause, resume, or cancel recurring maintenance for a registered farm.",
    inputSchema: manageSchema,
    handler: async ({ farmId, action }) => {
      const status = action === "resume" ? "active" : action === "pause" ? "paused" : "cancelled";
      if (!scheduler.setStatus(farmId, status)) {
        return {
          ok: false, summary: `could not ${action} farm ${farmId}`,
          code: "TARGET_UNAVAILABLE", recoverable: false,
        };
      }
      return { ok: true, summary: `${action}d farm ${farmId}` };
    },
  };
}
