import { z } from "zod";
import { Vec3 } from "vec3";
import type { DB } from "../../memory/db.js";
import {
  recordWorldObservations,
  type ObservationKind,
  type WorldObservationInput,
} from "../../exploration/store.js";
import { goals, isFlightEnabled, pathfindTo } from "../pathfinder.js";
import { flyToPosition } from "../flight.js";
import { defineSkill, type SkillDefinition } from "../types.js";
import { recordMapSurvey } from "../../exploration/mapStore.js";

const RESOURCE_BLOCKS = new Set([
  "coal_ore", "deepslate_coal_ore",
  "iron_ore", "deepslate_iron_ore",
  "copper_ore", "deepslate_copper_ore",
  "gold_ore", "deepslate_gold_ore", "nether_gold_ore",
  "redstone_ore", "deepslate_redstone_ore",
  "lapis_ore", "deepslate_lapis_ore",
  "diamond_ore", "deepslate_diamond_ore",
  "emerald_ore", "deepslate_emerald_ore",
  "nether_quartz_ore", "ancient_debris",
]);

const HAZARD_BLOCKS = new Set([
  "lava", "fire", "soul_fire", "magma_block", "cactus",
  "sweet_berry_bush", "powder_snow", "campfire", "soul_campfire",
]);

const CONTAINER_BLOCKS = new Set([
  "chest", "trapped_chest", "barrel", "ender_chest",
  "shulker_box",
]);

const INFRASTRUCTURE_BLOCKS = new Set([
  "crafting_table", "furnace", "blast_furnace", "smoker",
  "anvil", "chipped_anvil", "damaged_anvil",
  "enchanting_table", "brewing_stand", "beacon",
  "nether_portal", "lodestone",
]);

const TARGET_NAMES = [
  ...RESOURCE_BLOCKS,
  ...HAZARD_BLOCKS,
  ...CONTAINER_BLOCKS,
  ...INFRASTRUCTURE_BLOCKS,
];

const params = z.object({
  dimension: z.string().min(1).max(64).default("overworld"),
  centerX: z.number().int().min(-30_000_000).max(30_000_000),
  centerY: z.number().int().min(-64).max(320),
  centerZ: z.number().int().min(-30_000_000).max(30_000_000),
  radius: z.number().int().min(4).max(32).default(16),
  label: z.string().min(1).max(64).optional(),
});

export function surveyArea(
  db: DB,
  serverKey = "legacy",
): SkillDefinition<z.infer<typeof params>> {
  return defineSkill({
    name: "surveyArea",
    policy: { minimumRole: "operator", effect: "world-change", reversible: false, mission: "public" },
    description:
      "Travel to a bounded survey point and persist nearby ores, hazards, containers, " +
      "infrastructure, and a landmark in the world map.",
    params,
    longRunning: true,
    async run({ dimension, centerX, centerY, centerZ, radius, label }, ctx) {
      const currentDimension = ctx.bot.game?.dimension;
      if (currentDimension && currentDimension !== dimension) {
        return {
          ok: false,
          summary: `survey is in ${dimension} but bot is in ${currentDimension}`,
          code: "TARGET_UNAVAILABLE",
          recoverable: true,
          details: { expectedDimension: dimension, currentDimension },
        };
      }
      try {
        if (isFlightEnabled()) {
          await flyToPosition(
            ctx.bot,
            new Vec3(centerX + 0.5, centerY, centerZ + 0.5),
            3,
            ctx.signal,
          );
        } else {
          await pathfindTo(
            ctx.bot,
            new goals.GoalNear(centerX, centerY, centerZ, 3),
            ctx.signal,
          );
        }
      } catch (err) {
        const message = (err as Error).message ?? String(err);
        return {
          ok: false,
          summary: message === "aborted" ? "survey interrupted" : `could not reach survey point: ${message}`,
          code: message === "aborted" ? "INTERRUPTED" : "NO_PATH",
          recoverable: true,
          details: { centerX, centerY, centerZ, message },
        };
      }
      if (typeof ctx.bot.findBlocks !== "function") {
        return {
          ok: false, summary: "block scanning is unavailable",
          code: "PLUGIN_UNAVAILABLE", recoverable: false,
        };
      }

      const blockIds = TARGET_NAMES
        .map((name) => ctx.bot.registry?.blocksByName?.[name]?.id)
        .filter((id): id is number => typeof id === "number");
      const observations: WorldObservationInput[] = [{
        dimension,
        x: centerX,
        y: centerY,
        z: centerZ,
        kind: "landmark",
        name: label?.trim().toLowerCase() ?? "survey_point",
        details: { radius },
      }];
      if (blockIds.length > 0) {
        const positions = ctx.bot.findBlocks({
          matching: blockIds,
          maxDistance: radius,
          count: 256,
          point: new Vec3(centerX, centerY, centerZ),
        });
        for (const position of positions) {
          const block = ctx.bot.blockAt(position);
          if (!block) continue;
          const kind = classify(block.name);
          if (!kind) continue;
          observations.push({
            dimension,
            x: position.x,
            y: position.y,
            z: position.z,
            kind,
            name: block.name,
          });
        }
      }
      recordWorldObservations(db, observations, Date.now(), serverKey);
      recordMapSurvey(db, {
        serverKey,
        dimension,
        x: centerX,
        y: centerY,
        z: centerZ,
        radius,
        label: label?.trim() || "survey area",
      });
      const counts: Record<string, number> = {};
      for (const entry of observations) {
        const key = `${entry.kind}:${entry.name}`;
        counts[key] = (counts[key] ?? 0) + 1;
      }
      return {
        ok: true,
        summary: `surveyed ${radius} blocks around ${centerX},${centerY},${centerZ} ` +
          `and recorded ${observations.length} observations`,
        data: {
          dimension,
          center: [centerX, centerY, centerZ],
          radius,
          observationCount: observations.length,
          counts,
        },
      };
    },
  });
}

function classify(name: string): ObservationKind | undefined {
  if (RESOURCE_BLOCKS.has(name)) return "resource";
  if (HAZARD_BLOCKS.has(name)) return "hazard";
  if (
    CONTAINER_BLOCKS.has(name) ||
    name.endsWith("_shulker_box")
  ) return "container";
  if (INFRASTRUCTURE_BLOCKS.has(name)) return "infrastructure";
  return undefined;
}
