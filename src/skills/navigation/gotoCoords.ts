import { z } from "zod";
import { defineSkill } from "../types.js";
import {
  goals,
  isFlightEnabled,
  pathfindTo,
  pathfindingFailureDetails,
} from "../pathfinder.js";
import { Vec3 } from "vec3";
import { flyToPosition } from "../flight.js";

export const gotoCoords = defineSkill({
  name: "gotoCoords",
  policy: { minimumRole: "operator", effect: "world-change", reversible: false, mission: "public" },
  description:
    "Move the bot to specific block coordinates (x, y, z) in the current dimension. " +
    "Use this when the owner gives explicit coordinates.",
  params: z.object({
    x: z.number().finite().int().min(-30_000_000).max(30_000_000),
    y: z.number().finite().int().min(-64).max(320),
    z: z.number().finite().int().min(-30_000_000).max(30_000_000),
    range: z.number().int().min(0).max(8).default(1).describe(
      "How close (in blocks) the bot must get before the skill succeeds.",
    ),
  }),
  async run({ x, y, z, range }, ctx) {
    const goal = new goals.GoalNear(x, y, z, range);
    ctx.log.info({ x, y, z, range }, "gotoCoords: starting pathfind");
    try {
      const navigation = isFlightEnabled()
        ? await flyToPosition(ctx.bot, new Vec3(x + 0.5, y, z + 0.5), range, ctx.signal)
        : await pathfindTo(ctx.bot, goal, ctx.signal);
      return {
        ok: true,
        summary: `Reached (${x}, ${y}, ${z}).`,
        data: { x, y, z, range, navigation },
      };
    } catch (err) {
      const msg = (err as Error).message ?? String(err);
      if (msg === "aborted") {
        return { ok: false, summary: "gotoCoords cancelled.", code: "INTERRUPTED", recoverable: true };
      }
      return {
        ok: false,
        summary: `gotoCoords failed: ${msg}`,
        code: "NO_PATH",
        recoverable: true,
        details: {
          x,
          y,
          z,
          range,
          message: msg,
          ...pathfindingFailureDetails(err),
        },
      };
    }
  },
});
