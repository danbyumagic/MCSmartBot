import { z } from "zod";
import { goals, pathfindTo } from "../pathfinder.js";
import { defineSkill } from "../types.js";
import {
  entitySelectorSchema,
  resolveEntitySelector,
  type EntitySelector,
  type EntitySelectorFailure,
  type EntitySelectorSuccess,
  type EntityTarget,
} from "./entitySelector.js";

const MAX_INTERACTION_DISTANCE = 32;
const INTERACTION_REACH = 3.5;

/** Activate one bounded, freshly resolved entity without exposing raw entities. */
export const activateEntity = defineSkill({
  name: "activateEntity",
  policy: { minimumRole: "operator", effect: "world-change", reversible: false, mission: "public" },
  description:
    "Interact with one exact live entity selected by recent entity ID, exact player username, or exact type within a bounded radius. " +
    "The entity is resolved again immediately before Mineflayer interaction.",
  params: z.object({ selector: entitySelectorSchema }),
  async run({ selector }, ctx) {
    if (ctx.signal.aborted) return interrupted();
    const initial = resolveEntitySelector(ctx.bot, selector);
    if (!initial.ok) return initial;
    if (initial.target.distance > MAX_INTERACTION_DISTANCE) return tooFar(initial.target);

    const reached = await reachEntity(ctx, selector, initial.target);
    if (!reached.ok) return reached;
    if (ctx.signal.aborted) return interrupted(reached.target, false);
    try {
      await ctx.bot.activateEntity(reached.entity);
    } catch (error) {
      if (ctx.signal.aborted) return interrupted(reached.target, true);
      const message = errorMessage(error);
      return {
        ok: false,
        summary: `failed to activate ${label(reached.target)}: ${message}`,
        code: "SERVER_REJECTED",
        recoverable: true,
        details: { target: reached.target, message },
      };
    }
    if (ctx.signal.aborted) return interrupted(reached.target, true);
    return {
      ok: true,
      summary: `activated ${label(reached.target)}`,
      data: { target: reached.target },
    };
  },
});

async function reachEntity(
  ctx: Parameters<typeof activateEntity.run>[1],
  selector: EntitySelector,
  initial: EntityTarget,
): Promise<EntitySelectorSuccess | EntitySelectorFailure | ReachFailure> {
  if (initial.distance > INTERACTION_REACH) {
    try {
      await pathfindTo(
        ctx.bot,
        new goals.GoalNear(initial.position.x, initial.position.y, initial.position.z, 2),
        ctx.signal,
      );
    } catch (error) {
      if (ctx.signal.aborted || errorMessage(error) === "aborted") return interrupted(initial, false);
      return {
        ok: false,
        summary: `could not reach ${label(initial)}: ${errorMessage(error)}`,
        code: "NO_PATH",
        recoverable: true,
        details: { target: initial },
      };
    }
  }
  if (ctx.signal.aborted) return interrupted(initial, false);
  const current = resolveEntitySelector(ctx.bot, selector);
  if (!current.ok) return current;
  if (current.target.id !== initial.id) {
    return {
      ok: false,
      summary: "entity selector resolved to a different live target after routing",
      code: "TARGET_UNAVAILABLE",
      recoverable: true,
      details: { before: initial, current: current.target },
    };
  }
  if (current.target.distance > INTERACTION_REACH) return tooFar(current.target, INTERACTION_REACH);
  return current;
}

interface ReachFailure {
  readonly ok: false;
  readonly summary: string;
  readonly code: "NO_PATH" | "TARGET_UNAVAILABLE" | "INTERRUPTED";
  readonly recoverable: boolean;
  readonly details?: Record<string, unknown>;
}

function tooFar(target: EntityTarget, reach = MAX_INTERACTION_DISTANCE): ReachFailure {
  return {
    ok: false as const,
    summary: `${label(target)} is ${target.distance} blocks away; bounded interaction range is ${reach}`,
    code: "TARGET_UNAVAILABLE" as const,
    recoverable: true,
    details: { target, maximumDistance: reach },
  };
}

function interrupted(target?: EntityTarget, actionMayHaveCompleted = false): ReachFailure {
  return {
    ok: false as const,
    summary: "entity activation interrupted",
    code: "INTERRUPTED" as const,
    recoverable: true,
    details: {
      ...(target === undefined ? {} : { target }),
      ...(actionMayHaveCompleted ? { actionMayHaveCompleted: true } : {}),
    },
  };
}

function label(target: EntityTarget): string {
  return target.username ?? target.name;
}

function errorMessage(error: unknown): string {
  return (error instanceof Error ? error.message : String(error)).slice(0, 512);
}
