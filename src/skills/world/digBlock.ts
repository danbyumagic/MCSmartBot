import { z } from "zod";
import { digAt } from "../../world/blockExecutor.js";
import type { BlockMutationResult, BlockPosition } from "../../world/types.js";
import { defineSkill, type SkillResult } from "../types.js";
import {
  collectNewDrops,
  nearbyDropIds,
  type DropPickupReport,
} from "./dropPickup.js";
import {
  beginWorldJournal,
  createJournalMutation,
  finalizeSingleWorldJournal,
  isStartedWorldJournal,
  preflightWorldJournal,
  transactionDetails,
  type WorldSkillDependencies,
} from "./journal.js";

const coordinate = z.number().int().min(-30_000_000).max(30_000_000);

/** A single verified, journaled block dig. */
export function createDigBlockSkill(deps: WorldSkillDependencies) {
  return defineSkill({
    name: "digBlock",
    policy: { minimumRole: "operator", effect: "world-change", reversible: true, mission: "public" },
    description:
      "Dig one exact block at integer x/y/z, verify the world became air, and optionally make a bounded best-effort pass over newly observed drops.",
    params: z.object({
      x: coordinate,
      y: coordinate,
      z: coordinate,
      collectDrops: z.boolean().default(true).describe("Whether to make a bounded best-effort pickup attempt for newly observed drops."),
    }),
    async run({ x, y, z, collectDrops }, ctx) {
      const position = Object.freeze({ x, y, z });
      const journal = beginWorldJournal(deps, ctx, {
        kind: "atomic-dig",
        label: `dig at ${x},${y},${z}`,
      });
      if (!isStartedWorldJournal(journal)) return journal;
      const preflight = preflightWorldJournal(deps, journal, ctx, 1);
      if (preflight) return preflight;

      const beforeDrops = collectDrops ? nearbyDropIds(ctx.bot, position) : undefined;
      const mutation = createJournalMutation(deps, journal, ctx, 0);
      const result = await digAt(ctx.bot as never, {
        position,
        signal: ctx.signal,
        hooks: mutation.hooks,
      });
      const transaction = finalizeSingleWorldJournal(deps, journal, mutation, result.summary);
      let dropPickup: DropPickupReport | undefined;
      if (result.ok && collectDrops && beforeDrops) {
        dropPickup = await collectNewDrops(ctx, position, beforeDrops);
      }
      return asSkillResult(result, position, collectDrops, transactionDetails(transaction), dropPickup);
    },
  });
}

function asSkillResult(
  result: BlockMutationResult,
  position: BlockPosition,
  collectDrops: boolean,
  transaction: Record<string, unknown> | undefined,
  dropPickup: DropPickupReport | undefined,
): SkillResult {
  const details = {
    ...(result.details ?? {}),
    position,
    collectDrops,
    ...(dropPickup === undefined ? {} : { dropPickup }),
    ...(transaction === undefined ? {} : { transaction }),
  };
  if (!result.ok) {
    return {
      ok: false,
      summary: result.summary,
      code: result.code ?? "UNKNOWN",
      recoverable: result.recoverable ?? true,
      details,
    };
  }
  return {
    ok: true,
    summary: result.summary,
    details,
    data: {
      position,
      before: result.before,
      after: result.after,
      collectDrops,
      ...(dropPickup === undefined ? {} : { dropPickup }),
      ...(transaction === undefined ? {} : { transaction }),
    },
  };
}
