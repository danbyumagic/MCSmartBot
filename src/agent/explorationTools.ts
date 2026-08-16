import { z } from "zod";
import {
  OBSERVATION_KINDS,
  queryWorldObservations,
} from "../exploration/store.js";
import type { DB } from "../memory/db.js";
import {
  TaskPlanAuthorizationError,
  type TaskEngine,
} from "../tasks/engine.js";
import type { ToolDef } from "./tools.js";
import {
  snapshotExecutionActor,
  type ExecutionActor,
} from "../permissions/executionActor.js";

const startSchema = z.object({
  dimension: z.string().min(1).max(64).default("overworld"),
  centerX: z.number().int().min(-30_000_000).max(30_000_000),
  centerY: z.number().int().min(-64).max(320),
  centerZ: z.number().int().min(-30_000_000).max(30_000_000),
  spacing: z.number().int().min(0).max(64).default(24),
  gridSize: z.number().int().min(1).max(7).refine((value) => value % 2 === 1, {
    message: "gridSize must be odd (1, 3, 5, or 7)",
  }).default(3),
  routePattern: z.enum(["zigzag", "center_out"]).default("zigzag"),
  scanRadius: z.number().int().min(4).max(32).default(16),
  label: z.string().min(1).max(48).default("survey"),
});

export function createStartSurveyTool(
  tasks: TaskEngine,
  actorProvider: () => ExecutionActor,
): ToolDef<z.infer<typeof startSchema>> {
  return {
    name: "startSurvey",
    policy: { minimumRole: "operator", effect: "world-change", reversible: false, mission: "forbidden" },
    description:
      "Create a durable bounded survey route centered on inspected coordinates. " +
      "Spacing 0 scans one point; positive spacing scans an odd-sized grid and persists discoveries. " +
      "The default zigzag route is a lawnmower pattern suitable for aerial mapping when flight is enabled.",
    inputSchema: startSchema,
    handler: async (input) => {
      const actor = snapshotExecutionActor(actorProvider());
      const offsets = input.spacing === 0
        ? [[0, 0] as const]
        : input.routePattern === "zigzag"
          ? createZigzagOffsets(input.gridSize)
          : createCenterOutOffsets(input.gridSize);
      try {
        const plan = tasks.create({
          title: `survey ${input.label} around ${input.centerX},${input.centerY},${input.centerZ}`,
          steps: offsets.map(([dx, dz], index) => ({
            skill: "surveyArea",
            params: {
              dimension: input.dimension,
              centerX: input.centerX + dx * input.spacing,
              centerY: input.centerY,
              centerZ: input.centerZ + dz * input.spacing,
              radius: input.scanRadius,
              label: `${input.label}_${index + 1}`,
            },
            maxAttempts: 3,
          })),
          actor,
        });
        return {
          ok: true,
          summary: `started survey task plan ${plan.id} with ${plan.steps.length} points`,
        };
      } catch (err) {
        if (err instanceof TaskPlanAuthorizationError) {
          return {
            ok: false,
            summary: `could not start survey: ${err.message}`,
            code: "PERMISSION_DENIED",
            recoverable: false,
            details: err.details,
          };
        }
        return {
          ok: false,
          summary: `could not start survey: ${(err as Error).message}`,
          code: "INVALID_PARAMS",
          recoverable: false,
        };
      }
    },
  };
}

export function createZigzagOffsets(size: number): Array<readonly [number, number]> {
  const half = Math.floor(size / 2);
  const offsets: Array<readonly [number, number]> = [];
  for (let z = -half; z <= half; z++) {
    const xs = Array.from({ length: size }, (_, index) => index - half);
    if ((z + half) % 2 === 1) xs.reverse();
    for (const x of xs) offsets.push([x, z] as const);
  }
  return offsets;
}

function createCenterOutOffsets(size: number): Array<readonly [number, number]> {
  if (size === 1) return [[0, 0]];
  const all = createZigzagOffsets(size);
  return all.sort((a, b) => {
    const da = Math.max(Math.abs(a[0]), Math.abs(a[1]));
    const db = Math.max(Math.abs(b[0]), Math.abs(b[1]));
    return da - db;
  });
}

const querySchema = z.object({
  dimension: z.string().min(1).max(64).optional(),
  kind: z.enum(OBSERVATION_KINDS).optional(),
  name: z.string().min(1).max(64).optional(),
  centerX: z.number().int().min(-30_000_000).max(30_000_000).optional(),
  centerY: z.number().int().min(-64).max(320).optional(),
  centerZ: z.number().int().min(-30_000_000).max(30_000_000).optional(),
  radius: z.number().int().min(1).max(4096).optional(),
  limit: z.number().int().min(1).max(50).default(20),
});

export function createQueryWorldMapTool(
  db: DB,
  serverKey = "legacy",
): ToolDef<z.infer<typeof querySchema>> {
  return {
    name: "queryWorldMap",
    policy: { minimumRole: "viewer", effect: "read", reversible: false, mission: "forbidden" },
    description:
      "Query persistent survey observations by dimension, kind, block name, and optional radius.",
    inputSchema: querySchema,
    handler: async (input) => {
      const coordinates = [input.centerX, input.centerY, input.centerZ];
      const supplied = coordinates.filter((value) => value !== undefined).length;
      if (supplied !== 0 && supplied !== 3) {
        return {
          ok: false,
          summary: "centerX centerY and centerZ must be supplied together",
          code: "INVALID_PARAMS",
          recoverable: false,
        };
      }
      if (input.radius !== undefined && supplied !== 3) {
        return {
          ok: false,
          summary: "radius requires centerX centerY and centerZ",
          code: "INVALID_PARAMS",
          recoverable: false,
        };
      }
      const rows = queryWorldObservations(db, { ...input, serverKey });
      return {
        ok: true,
        summary: JSON.stringify({
          count: rows.length,
          observations: rows.map((row) => ({
            kind: row.kind,
            name: row.name,
            dimension: row.dimension,
            position: [row.x, row.y, row.z],
            lastSeenAt: row.lastSeenAt,
            seenCount: row.seenCount,
            details: row.details,
          })),
        }),
      };
    },
  };
}
