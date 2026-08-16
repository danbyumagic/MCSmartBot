import { z } from "zod";
import { defineSkill, type SkillDefinition } from "../types.js";
import {
  goals,
  isFlightEnabled,
  pathfindTo,
  pathfindingFailureDetails,
} from "../pathfinder.js";
import { Vec3 } from "vec3";
import { flyToPosition } from "../flight.js";
import { getLocation } from "../../memory/locations.js";
import type { DB } from "../../memory/db.js";

const params = z.object({
  range: z.number().int().min(0).max(8).default(1),
});

export function returnToBase(db: DB): SkillDefinition<z.infer<typeof params>> {
  return defineSkill({
    name: "returnToBase",
    policy: { minimumRole: "operator", effect: "world-change", reversible: false, mission: "public" },
    description:
      "Move the bot back to the saved 'base' location. The owner must have set 'base' via the `rememberLocation` " +
      "tool or the CLI first; otherwise the skill fails with an explanation.",
    params,
    async run({ range }, ctx) {
      const base = getLocation(db, "base");
      if (!base) {
        return {
          ok: false,
          summary: "No 'base' location is set. Ask the owner to remember a location named 'base' first.",
          code: "NOT_CONFIGURED",
          recoverable: true,
          details: { requiredLocation: "base" },
        };
      }
      const { x, y, z } = base;
      const goal = new goals.GoalNear(x, y, z, range);
      ctx.log.info({ x, y, z, range }, "returnToBase: pathfinding");
      try {
        const navigation = isFlightEnabled()
          ? await flyToPosition(ctx.bot, new Vec3(x + 0.5, y, z + 0.5), range, ctx.signal)
          : await pathfindTo(ctx.bot, goal, ctx.signal);
        return {
          ok: true,
          summary: `Returned to base at (${x}, ${y}, ${z}).`,
          data: { x, y, z, navigation },
        };
      } catch (err) {
        const msg = (err as Error).message ?? String(err);
        if (msg === "aborted") {
          return { ok: false, summary: "returnToBase cancelled.", code: "INTERRUPTED", recoverable: true };
        }
        return {
          ok: false, summary: `returnToBase failed: ${msg}`,
          code: "NO_PATH",
          recoverable: true,
          details: {
            x,
            y,
            z,
            message: msg,
            ...pathfindingFailureDetails(err),
          },
        };
      }
    },
  });
}
