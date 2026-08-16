import { z } from "zod";
import { Vec3 } from "vec3";
import type { DB } from "../../memory/db.js";
import { getFarmByName, type FarmCrop } from "../../farming/store.js";
import { countInInventory } from "../helpers.js";
import { setFlightEnabled, isFlightEnabled } from "../pathfinder.js";
import { defineSkill, type SkillDefinition } from "../types.js";
import { chestDeposit } from "../resources/chestDeposit.js";

interface CropRule {
  maxAge: number;
  seedItem: string;
  outputItem: string;
  soil: string;
}

const CROP_RULES: Record<FarmCrop, CropRule> = {
  wheat: { maxAge: 7, seedItem: "wheat_seeds", outputItem: "wheat", soil: "farmland" },
  carrots: { maxAge: 7, seedItem: "carrot", outputItem: "carrot", soil: "farmland" },
  potatoes: { maxAge: 7, seedItem: "potato", outputItem: "potato", soil: "farmland" },
  beetroots: { maxAge: 3, seedItem: "beetroot_seeds", outputItem: "beetroot", soil: "farmland" },
  nether_wart: { maxAge: 3, seedItem: "nether_wart", outputItem: "nether_wart", soil: "soul_sand" },
};

const params = z.object({
  farmName: z.string().min(1).max(64),
});

export function harvestFarm(db: DB): SkillDefinition<z.infer<typeof params>> {
  const deposit = chestDeposit(db);
  return defineSkill({
    name: "harvestFarm",
    policy: { minimumRole: "operator", effect: "world-change", reversible: false, mission: "public" },
    description:
      "Harvest only mature crops inside a registered farm boundary, replant every harvested block, " +
      "preserve the configured seed reserve, and optionally deposit output.",
    params,
    longRunning: true,
    async run({ farmName }, ctx) {
      const farm = getFarmByName(db, farmName);
      if (!farm) {
        return {
          ok: false, summary: `no registered farm named '${farmName}'`,
          code: "NOT_CONFIGURED", recoverable: true, details: { farmName },
        };
      }
      const dimension = ctx.bot.game?.dimension;
      if (dimension && dimension !== farm.dimension) {
        return {
          ok: false,
          summary: `farm '${farmName}' is in ${farm.dimension} but bot is in ${dimension}`,
          code: "TARGET_UNAVAILABLE",
          recoverable: true,
          details: { farmName, expectedDimension: farm.dimension, currentDimension: dimension },
        };
      }
      const rule = CROP_RULES[farm.crop];
      const mature = [];
      for (let x = farm.minX; x <= farm.maxX; x++) {
        for (let y = farm.minY; y <= farm.maxY; y++) {
          for (let zPos = farm.minZ; zPos <= farm.maxZ; zPos++) {
            const block = ctx.bot.blockAt(new Vec3(x, y, zPos));
            if (!block || block.name !== farm.crop) continue;
            const properties = block.getProperties?.() ?? {};
            const age = Number(properties.age ?? block.metadata);
            if (age >= rule.maxAge) mature.push(block);
          }
        }
      }
      if (mature.length === 0) {
        return {
          ok: true,
          summary: `farm '${farmName}' has no mature ${farm.crop}`,
          data: { farmName, mature: 0, harvested: 0, replanted: 0 },
        };
      }

      // A seed must exist before the first destructive action. Subsequent
      // harvests may replenish the reserve, but each iteration checks again.
      if (countInInventory(ctx.bot, rule.seedItem) < 1) {
        return {
          ok: false,
          summary: `cannot harvest '${farmName}': no ${rule.seedItem} available for replanting`,
          code: "NO_MATERIAL",
          recoverable: true,
          details: { farmName, requiredItem: rule.seedItem, required: 1 },
        };
      }

      const initialOutput = countInInventory(ctx.bot, rule.outputItem);
      let harvested = 0;
      let replanted = 0;
      for (const crop of mature) {
        if (ctx.signal.aborted) {
          return interrupted(farmName, mature.length, harvested, replanted);
        }
        if (countInInventory(ctx.bot, rule.seedItem) < 1) {
          return {
            ok: false,
            summary: `harvest paused after ${harvested}: out of ${rule.seedItem} for replanting`,
            code: "NO_MATERIAL",
            recoverable: true,
            details: { farmName, harvested, replanted, requiredItem: rule.seedItem },
          };
        }
        try {
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          const bot = ctx.bot as any;
          if (typeof bot.collectBlock?.collect !== "function") {
            return {
              ok: false, summary: "mineflayer-collectblock plugin not loaded",
              code: "PLUGIN_UNAVAILABLE", recoverable: false,
            };
          }
          await bot.collectBlock.collect(crop);
          setFlightEnabled(ctx.bot, isFlightEnabled());
          harvested++;

          const soil = ctx.bot.blockAt(crop.position.offset(0, -1, 0));
          if (!soil || soil.name !== rule.soil) {
            return {
              ok: false,
              summary: `cannot replant at ${crop.position}: expected ${rule.soil}`,
              code: "AREA_UNSAFE",
              recoverable: true,
              details: { farmName, position: crop.position.toString(), expectedSoil: rule.soil },
            };
          }
          const seed = ctx.bot.inventory.items()
            .find((item) => item.name === rule.seedItem);
          if (!seed) {
            return {
              ok: false, summary: `harvested but cannot replant: no ${rule.seedItem}`,
              code: "NO_MATERIAL", recoverable: true,
              details: { farmName, harvested, replanted, requiredItem: rule.seedItem },
            };
          }
          await ctx.bot.equip(seed, "hand");
          await ctx.bot.placeBlock(soil, new Vec3(0, 1, 0));
          replanted++;
          ctx.reportProgress(`${replanted}/${mature.length} ${farm.crop} replanted`);
        } catch (err) {
          const message = (err as Error).message ?? String(err);
          if (ctx.signal.aborted || message === "aborted") {
            return interrupted(farmName, mature.length, harvested, replanted);
          }
          return {
            ok: false,
            summary: `farm '${farmName}' failed after ${harvested} harvests: ${message}`,
            code: "UNKNOWN",
            recoverable: true,
            details: { farmName, harvested, replanted, message },
          };
        }
      }

      let deposited = 0;
      if (farm.storageName) {
        const keepCount = rule.outputItem === rule.seedItem ? farm.seedReserve : 0;
        const result = await deposit.run({
          chestName: farm.storageName,
          itemFilter: rule.outputItem,
          keepCount,
        }, ctx);
        if (!result.ok) return result;
        deposited = Number(result.data?.deposited ?? 0);
      }
      const collected = Math.max(
        0,
        countInInventory(ctx.bot, rule.outputItem) - initialOutput + deposited,
      );
      return {
        ok: true,
        summary: `farm '${farmName}' harvested ${harvested} and replanted ${replanted}`,
        data: {
          farmName,
          crop: farm.crop,
          mature: mature.length,
          harvested,
          replanted,
          collected,
          deposited,
        },
      };
    },
  });
}

function interrupted(
  farmName: string,
  mature: number,
  harvested: number,
  replanted: number,
) {
  return {
    ok: false as const,
    summary: `farm '${farmName}' interrupted after ${harvested}/${mature}`,
    code: "INTERRUPTED" as const,
    recoverable: true,
    details: { farmName, mature, harvested, replanted },
  };
}
