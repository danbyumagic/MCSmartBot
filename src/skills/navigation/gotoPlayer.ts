import { z } from "zod";
import { defineSkill } from "../types.js";
import {
  goals,
  isFlightEnabled,
  pathfindTo,
  pathfindingFailureDetails,
} from "../pathfinder.js";
import { flyToPosition } from "../flight.js";
import { resolveOnlinePlayer } from "../../bot/playerIdentity.js";

export const gotoPlayer = defineSkill({
  name: "gotoPlayer",
  policy: { minimumRole: "operator", effect: "world-change", reversible: false, mission: "public" },
  description:
    "Move the bot to a specific player by username. The player must be online and within render range. " +
    "Use this when the owner says things like 'come here' or 'come to <name>'.",
  params: z.object({
    username: z.string().trim().min(1).max(64),
    range: z.number().int().min(0).max(8).default(2).describe(
      "How close (in blocks) to the player before the skill succeeds.",
    ),
  }),
  async run({ username, range }, ctx) {
    const resolved = resolveOnlinePlayer(ctx.bot, username);
    if (!resolved) {
      return {
        ok: false,
        summary: `Player '${username}' is not online (cannot find in bot.players).`,
        code: "TARGET_UNAVAILABLE",
        recoverable: true,
        details: { username, reason: "offline" },
      };
    }
    if (!resolved.player.entity) {
      return {
        ok: false,
        summary: `Player '${resolved.username}' is online but outside render range — no entity to follow.`,
        code: "TARGET_UNAVAILABLE",
        recoverable: true,
        details: {
          requestedUsername: username,
          resolvedUsername: resolved.username,
          reason: "outside_render_range",
        },
      };
    }
    const goal = new goals.GoalFollow(resolved.player.entity, range);
    ctx.log.info(
      { requestedUsername: username, username: resolved.username, range },
      "gotoPlayer: starting pathfind",
    );
    try {
      const navigation = isFlightEnabled()
        ? await flyToPosition(ctx.bot, resolved.player.entity.position.clone(), range, ctx.signal)
        : await pathfindTo(ctx.bot, goal, ctx.signal);
      return {
        ok: true,
        summary: `Reached ${resolved.username}.`,
        data: {
          requestedUsername: username,
          username: resolved.username,
          range,
          navigation,
        },
      };
    } catch (err) {
      const msg = (err as Error).message ?? String(err);
      if (msg === "aborted") {
        return { ok: false, summary: `gotoPlayer ${resolved.username} cancelled.`, code: "INTERRUPTED", recoverable: true };
      }
      return {
        ok: false,
        summary: `gotoPlayer ${resolved.username} failed: ${msg}`,
        code: "NO_PATH",
        recoverable: true,
        details: {
          requestedUsername: username,
          resolvedUsername: resolved.username,
          range,
          message: msg,
          ...pathfindingFailureDetails(err),
        },
      };
    }
  },
});
