import { z } from "zod";
import { defineSkill, type SkillContext } from "../types.js";
import {
  followPlayerUntilAborted,
  isFlightEnabled,
  pathfindingFailureDetails,
} from "../pathfinder.js";
import { adaptiveFollowUntilAborted } from "../flight.js";
import type { Entity } from "prismarine-entity";
import { resolveOnlinePlayer } from "../../bot/playerIdentity.js";

export const followPlayer = defineSkill({
  name: "followPlayer",
  policy: { minimumRole: "operator", effect: "world-change", reversible: false, mission: "forbidden" },
  description:
    "Continuously follow a named player. Runs forever until another skill is invoked or the `stop` tool is called. " +
    "Use this when the owner says 'follow me', 'come with me', 'stay with me'. " +
    "When flight is enabled it follows adaptively: walking/swimming while the player is grounded " +
    "or in water, and taking off only when the player is actually flying. " +
    "For one-shot 'come to me' / 'come here', prefer `gotoPlayer` (which stops on arrival).",
  longRunning: true,
  params: z.object({
    username: z.string().trim().min(1).max(64),
    range: z.number().int().min(0).max(8).default(2).describe(
      "Maintain at most this many blocks of distance from the player.",
    ),
  }),
  async run({ username, range }, ctx) {
    const resolved = resolveOnlinePlayer(ctx.bot, username);
    if (!resolved) {
      return {
        ok: false, summary: `Player '${username}' is not online.`,
        code: "TARGET_UNAVAILABLE", recoverable: true, details: { username, reason: "offline" },
      };
    }
    if (!resolved.player.entity) {
      return {
        ok: false, summary: `Player '${resolved.username}' is online but outside render range.`,
        code: "TARGET_UNAVAILABLE", recoverable: true,
        details: {
          requestedUsername: username,
          resolvedUsername: resolved.username,
          reason: "outside_render_range",
        },
      };
    }
    ctx.log.info(
      { requestedUsername: username, username: resolved.username, range },
      "followPlayer: starting continuous follow",
    );
    try {
      const resolveEntity = () => resolveOnlinePlayer(ctx.bot, username)?.player.entity;
      if (isFlightEnabled()) {
        const detector = createTargetFlightDetector(ctx.bot);
        await adaptiveFollowUntilAborted(
          ctx.bot,
          () => {
            const entity = resolveEntity();
            return entity
              ? { entity, flying: detector(entity) }
              : undefined;
          },
          range,
          ctx.signal,
        );
      } else {
        await followPlayerUntilAborted(ctx.bot, resolveEntity, range, ctx.signal);
      }
    } catch (err) {
      const msg = (err as Error).message ?? String(err);
      if (msg === "aborted") {
        return { ok: true, summary: `stopped following ${resolved.username}` };
      }
      return {
        ok: false, summary: `followPlayer ${resolved.username} failed: ${msg}`,
        code: "NO_PATH", recoverable: true,
        details: {
          requestedUsername: username,
          resolvedUsername: resolved.username,
          range,
          message: msg,
          ...pathfindingFailureDetails(err),
        },
      };
    }
    // Unreachable — followUntilAborted never resolves on its own.
    return { ok: true, summary: `done following ${resolved.username}` };
  },
});

function entityIsInFluid(bot: SkillContext["bot"], entity: Entity): boolean {
  try {
    const feet = bot.blockAt(entity.position.floored())?.name;
    const body = bot.blockAt(entity.position.offset(0, 1, 0).floored())?.name;
    return feet === "water" || body === "water" || feet === "bubble_column" || body === "bubble_column";
  } catch {
    return false;
  }
}

function hasSolidSupport(bot: SkillContext["bot"], entity: Entity, depth: number): boolean {
  try {
    for (let offset = 0; offset <= depth; offset++) {
      const block = bot.blockAt(entity.position.offset(0, -0.2 - offset, 0).floored());
      if (!block) continue;
      if (!["air", "cave_air", "void_air", "water", "bubble_column", "lava"].includes(block.name)) {
        return true;
      }
    }
  } catch {
    // Missing chunks are treated as unsupported until the debounce confirms it.
  }
  return false;
}

/** Stateful debounce so an ordinary jump does not make the bot take off. */
export function createTargetFlightDetector(bot: SkillContext["bot"]): (entity: Entity) => boolean {
  let airborneSince: number | undefined;
  let flying = false;
  return (entity) => {
    if (entity.elytraFlying) return true;
    // Remote-player onGround is not reliably populated by Mineflayer in modern
    // protocols. Inspect the world immediately below the player's feet instead.
    if (entityIsInFluid(bot, entity) || hasSolidSupport(bot, entity, 0)) {
      airborneSince = undefined;
      flying = false;
      return false;
    }
    airborneSince ??= Date.now();
    const airborneFor = Date.now() - airborneSince;
    const hovering = Math.abs(entity.velocity?.y ?? 0) < 0.12;
    const noSurfaceNearby = !hasSolidSupport(bot, entity, 3);
    const wellAboveBot = Boolean(bot.entity && entity.position.y - bot.entity.position.y > 3);
    if (airborneFor >= 650 && (hovering || noSurfaceNearby || wellAboveBot)) flying = true;
    return flying;
  };
}
