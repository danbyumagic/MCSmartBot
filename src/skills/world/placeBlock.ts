import { z } from "zod";
import { placeAt } from "../../world/blockExecutor.js";
import type { BlockPosition, BlockMutationResult } from "../../world/types.js";
import { defineSkill, type SkillResult } from "../types.js";
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

/** A single verified, journaled block placement. */
export function createPlaceBlockSkill(deps: WorldSkillDependencies) {
  return defineSkill({
    name: "placeBlock",
    policy: { minimumRole: "operator", effect: "world-change", reversible: true, mission: "public" },
    description:
      "Place one exact carried block item at integer x/y/z. It never replaces a solid block and verifies the live result.",
    params: z.object({
      block: z.string().trim().min(1).max(128).describe("Exact Minecraft block item name, such as stone."),
      x: coordinate,
      y: coordinate,
      z: coordinate,
    }),
    async run({ block, x, y, z }, ctx) {
      const position = Object.freeze({ x, y, z });
      const item = block.toLowerCase();
      const journal = beginWorldJournal(deps, ctx, {
        kind: "atomic-place",
        label: `place ${item} at ${x},${y},${z}`,
      });
      if (!isStartedWorldJournal(journal)) return journal;
      const preflight = preflightWorldJournal(deps, journal, ctx, 1);
      if (preflight) return preflight;

      const mutation = createJournalMutation(deps, journal, ctx, 0);
      const result = await placeAt(ctx.bot as never, {
        position,
        item,
        signal: ctx.signal,
        hooks: mutation.hooks,
      });
      const transaction = finalizeSingleWorldJournal(deps, journal, mutation, result.summary);
      return asSkillResult(result, position, item, transactionDetails(transaction));
    },
  });
}

function asSkillResult(
  result: BlockMutationResult,
  position: BlockPosition,
  item: string,
  transaction: Record<string, unknown> | undefined,
): SkillResult {
  const detail = {
    ...(result.details ?? {}),
    position,
    item,
    ...(transaction === undefined ? {} : { transaction }),
  };
  if (!result.ok) {
    return {
      ok: false,
      summary: result.summary,
      code: result.code ?? "UNKNOWN",
      recoverable: result.recoverable ?? true,
      details: detail,
    };
  }
  return {
    ok: true,
    summary: result.summary,
    details: detail,
    data: {
      position,
      item,
      before: result.before,
      after: result.after,
      reference: result.reference,
      ...(transaction === undefined ? {} : { transaction }),
    },
  };
}
