// Portions adapted from yuniko-software/minecraft-mcp-server,
// src/tools/block-tools.ts @ 240c8cec337ce152cc9e058ebdef511055808406.
// Licensed under Apache-2.0; see LICENSES/yuniko-minecraft-mcp-Apache-2.0.txt.
// Modified by SmartBotMC: cancellation-aware reach handling, immutable
// snapshots, stale-state checks, and post-mutation verification.

import { Vec3 } from "vec3";
import {
  snapshotBlock,
  type BlockSnapshot,
} from "./blockSnapshot.js";
import {
  ensureReachableBlock,
  ensureReachableReference,
  floorBlockPosition,
  type PlacementReference,
  type PlacementReferenceSelection,
} from "./reach.js";
import type {
  BlockPosition,
  BlockMutationResult,
  BlockStatePredicate,
  IntendedBlockState,
} from "./types.js";
import type { BlockPropertyValue } from "./blockSnapshot.js";

export type BlockExpectation =
  | BlockSnapshot
  | Pick<BlockSnapshot, "name" | "position">
  | ((snapshot: BlockSnapshot) => boolean);

export interface BlockMutationHooks {
  /** Return a structured rejection to stop before the Mineflayer mutation. */
  planned?: (
    event: BlockMutationEvent,
  ) => void | BlockMutationHookFailure | Promise<void | BlockMutationHookFailure>;
  /**
   * A non-journaling authorization/revalidation boundary immediately before
   * Mineflayer receives the mutation. This runs only after a planned row has
   * been accepted and the executor's final stale-state reread has passed.
   * A rejection therefore terminalizes that already-planned row as failed.
   */
  beforeMutation?: (
    event: BlockMutationEvent,
  ) => void | BlockMutationHookFailure | Promise<void | BlockMutationHookFailure>;
  applied?: (event: BlockMutationEvent) => void | Promise<void>;
  /**
   * Mineflayer changed the block, but its observable postcondition differs
   * from the requested one. Persist the actual state as a conflict; this is
   * neither an unmade click nor an applied intended placement.
   */
  conflicted?: (event: BlockMutationConflict) => void | Promise<void>;
  failed?: (event: BlockMutationFailure) => void | Promise<void>;
}

export interface BlockMutationEvent {
  action: "place" | "dig";
  position: BlockPosition;
  before: BlockSnapshot;
  intended: BlockSnapshot | IntendedBlockState;
  reference?: SerializablePlacementReference;
}

export interface BlockMutationFailure extends BlockMutationEvent {
  code: NonNullable<BlockMutationResult["code"]>;
  summary: string;
}

export interface BlockMutationConflict extends BlockMutationEvent {
  readonly after: BlockSnapshot;
  readonly code: NonNullable<BlockMutationResult["code"]>;
  readonly summary: string;
}

/**
 * A journal hook can reject a mutation before Mineflayer is called while
 * preserving a stable, caller-visible failure code (for example, a world
 * change budget limit). Unlike a thrown hook error, this means no journal row
 * was planned and therefore no failed callback is emitted.
 */
export interface BlockMutationHookFailure {
  readonly ok: false;
  readonly code: NonNullable<BlockMutationResult["code"]>;
  readonly summary: string;
  readonly recoverable: boolean;
  readonly details?: Record<string, unknown>;
}

export interface SerializablePlacementReference {
  direction: string;
  position: BlockPosition;
  face: BlockPosition;
}

export interface PlaceAtInput {
  position: BlockPosition;
  item: string;
  signal: AbortSignal;
  expected?: BlockExpectation;
  /** Additional observable postcondition, evaluated only after the item name matches. */
  expectedAfter?: BlockStatePredicate;
  /** Properties recorded in the planned journal state and compared on reconciliation. */
  intendedProperties?: Readonly<Record<string, BlockPropertyValue>>;
  /**
   * Restricted internal support for a verified stateful placement adapter.
   * Ordinary callers leave this unset and retain Mineflayer's public
   * `placeBlock` path unchanged.
   */
  stateful?: StatefulPlacementOptions;
  /** Explicitly opt into replacement only after a caller has separately authorized it. */
  allowReplace?: boolean;
  hooks?: BlockMutationHooks;
}

export interface StatefulPlacementOptions {
  /** Mineflayer yaw (radians) already chosen by a stateful placement adapter. */
  readonly yaw: number;
  /** Click half recognized by Mineflayer's ordinary placement helper. */
  readonly half?: "top" | "bottom";
  /** Hard/preferred constraints over normal survival placement references. */
  readonly selection?: PlacementReferenceSelection;
}

export interface DigAtInput {
  position: BlockPosition;
  signal: AbortSignal;
  expected?: BlockExpectation;
  hooks?: BlockMutationHooks;
}

type BlockLike = {
  name: string;
  position: Vec3;
  stateId?: number;
  boundingBox?: string;
  diggable?: boolean;
  getProperties?: () => Record<string, unknown>;
};

type BotLike = {
  entity?: { position?: Vec3 };
  registry?: { itemsByName?: Record<string, { id?: number }> };
  inventory: { items(): Array<{ name: string; type?: number; count: number }> };
  blockAt(position: Vec3): BlockLike | null | undefined;
  equip(item: { name: string; type?: number; count: number }, destination: "hand"): Promise<void>;
  placeBlock(reference: BlockLike, face: Vec3): Promise<void>;
  /** Mineflayer's currently available but underscored ordinary placement helper. */
  _placeBlockWithOptions?: (
    reference: BlockLike,
    face: Vec3,
    options: { half?: "top" | "bottom"; forceLook?: boolean | "ignore" },
  ) => Promise<void>;
  look?: (yaw: number, pitch: number, force?: boolean) => Promise<void>;
  /** Mineflayer's optional second argument is forceLook, not collectDrops. */
  dig(block: BlockLike, forceLook?: boolean | "ignore"): Promise<void>;
  stopDigging?: () => void;
  canDigBlock?: (block: BlockLike) => boolean;
  canSeeBlock?: (block: BlockLike) => boolean;
  pathfinder?: {
    bestHarvestTool?: (block: BlockLike) => { name: string; type?: number; count?: number } | null | undefined;
  };
};

/**
 * Verified placement: the target is reread before mutation and again after it,
 * so a resolved Mineflayer promise never by itself counts as success.
 */
export async function placeAt(
  bot: BotLike,
  input: PlaceAtInput,
): Promise<BlockMutationResult> {
  const target = floorBlockPosition(input.position);
  const intendedResult = createIntendedState(input.item, input.intendedProperties);
  if (!intendedResult.ok) {
    return failure("INVALID_PARAMS", intendedResult.summary, false, intendedResult.details);
  }
  const intended = intendedResult.intended;
  const statefulFailure = validateStatefulPlacement(
    bot,
    input.stateful,
    input.expectedAfter,
    input.intendedProperties,
  );
  if (statefulFailure) return statefulFailure;
  const before = readSnapshot(bot, target);
  if (!before) return failure("WORLD_UNAVAILABLE", `world data unavailable at ${formatPosition(target)}`, true);
  if (!matchesExpected(before, input.expected)) {
    return failure("STALE_STATE", `block changed before placement at ${formatPosition(target)}`, false, {
      before,
    });
  }
  if (!before.replaceable && !input.allowReplace) {
    return failure("TARGET_UNAVAILABLE", `refusing to replace '${before.name}' at ${formatPosition(target)}`, false, {
      before,
    });
  }
  const registryItem = bot.registry?.itemsByName?.[input.item];
  if (!registryItem) {
    return failure("INVALID_PARAMS", `unknown or non-placeable item '${input.item}'`, false);
  }
  const item = bot.inventory.items().find((candidate) =>
    candidate.name === input.item &&
    candidate.count > 0 &&
    (typeof registryItem.id !== "number" || candidate.type === registryItem.id),
  );
  if (!item) {
    return failure("NO_MATERIAL", `no ${input.item} is available in inventory`, true, { item: input.item });
  }
  if (input.signal.aborted) return interrupted("place", target, before, intended, input.hooks);

  const reachable = await ensureReachableReference(
    bot as never,
    target,
    input.signal,
    input.stateful?.selection,
  );
  if (!reachable.ok) {
    return failure(reachable.code, reachable.summary, reachable.recoverable, reachable.details);
  }
  const reference = reachable.reference;
  const liveBefore = readSnapshot(bot, target);
  if (!liveBefore) return failure("WORLD_UNAVAILABLE", `world data unavailable at ${formatPosition(target)}`, true);
  if (!sameExpected(before, liveBefore) || !matchesExpected(liveBefore, input.expected)) {
    return failure("STALE_STATE", `block changed before placement at ${formatPosition(target)}`, false, {
      before,
      current: liveBefore,
    });
  }
  if (!liveBefore.replaceable && !input.allowReplace) {
    return failure("TARGET_UNAVAILABLE", `refusing to replace '${liveBefore.name}' at ${formatPosition(target)}`, false, {
      before: liveBefore,
    });
  }
  const liveReference = bot.blockAt(new Vec3(
    reference.position.x,
    reference.position.y,
    reference.position.z,
  ));
  if (!liveReference || liveReference.name === "air" || liveReference.boundingBox === "empty") {
    return failure("STALE_STATE", `placement reference changed near ${formatPosition(target)}`, false, {
      before: liveBefore,
    });
  }

  const serializableReference = serializeReference(reference);
  let event: BlockMutationEvent | undefined;
  let verifiedAfter: BlockSnapshot | undefined;
  try {
    if (input.signal.aborted) return interrupted("place", target, liveBefore, intended, input.hooks);
    await bot.equip(item, "hand");
    if (input.signal.aborted) return interrupted("place", target, liveBefore, intended, input.hooks);
    // equip() can await long enough for another player or redstone update to
    // change either endpoint, so reread immediately before recording/planning.
    const equippedBefore = readSnapshot(bot, target);
    const equippedReference = bot.blockAt(new Vec3(
      reference.position.x,
      reference.position.y,
      reference.position.z,
    ));
    if (!equippedBefore || !sameExpected(liveBefore, equippedBefore) ||
        !matchesExpected(equippedBefore, input.expected) ||
        (!equippedBefore.replaceable && !input.allowReplace) ||
        !equippedReference ||
        snapshotBlock(equippedReference, reference.position).key !== reference.snapshot.key) {
      return failure("STALE_STATE", `block changed before placement at ${formatPosition(target)}`, false, {
        before: liveBefore,
        current: equippedBefore ?? null,
      });
    }
    let preparedBefore = equippedBefore;
    if (input.stateful) {
      // A stateful click needs a deliberate player direction. Do this before
      // recording the durable mutation, then reread both endpoints because
      // Mineflayer's look promise can await long enough for the world to move.
      // Wait for Mineflayer's normal look completion so the rotation packet is
      // ordered before the stateful click. `force: true` only updates local
      // bookkeeping and can leave the server using the previous yaw.
      await lookWithAbort(bot, input.stateful.yaw, input.signal);
      if (input.signal.aborted) return interrupted("place", target, preparedBefore, intended, input.hooks);
      const lookedBefore = readSnapshot(bot, target);
      const lookedReference = bot.blockAt(new Vec3(
        reference.position.x,
        reference.position.y,
        reference.position.z,
      ));
      if (!lookedBefore || !sameExpected(preparedBefore, lookedBefore) ||
          !matchesExpected(lookedBefore, input.expected) ||
          (!lookedBefore.replaceable && !input.allowReplace) ||
          !lookedReference ||
          snapshotBlock(lookedReference, reference.position).key !== reference.snapshot.key) {
        return failure("STALE_STATE", `block changed before stateful placement at ${formatPosition(target)}`, false, {
          before: preparedBefore,
          current: lookedBefore ?? null,
        });
      }
      preparedBefore = lookedBefore;
    }
    event = {
      action: "place",
      position: target,
      before: preparedBefore,
      intended,
      reference: serializableReference,
    };
    const planned = await input.hooks?.planned?.(event);
    if (isHookFailure(planned)) {
      return failure(planned.code, planned.summary, planned.recoverable, planned.details);
    }
    // Hooks may be asynchronous (the durable journal is), so retain the same
    // stale-state guarantee after they return and just before Mineflayer acts.
    const finalBefore = readSnapshot(bot, target);
    const finalReference = bot.blockAt(new Vec3(
      reference.position.x,
      reference.position.y,
      reference.position.z,
    ));
    if (!finalBefore || !sameExpected(preparedBefore, finalBefore) ||
        !finalReference ||
        snapshotBlock(finalReference, reference.position).key !== reference.snapshot.key) {
      const result = failure("STALE_STATE", `block changed before placement at ${formatPosition(target)}`, false, {
        before: preparedBefore,
        current: finalBefore ?? null,
      });
      await notifyFailure(input.hooks, event, result);
      return result;
    }
    const beforeMutation = await input.hooks?.beforeMutation?.(event);
    if (isHookFailure(beforeMutation)) {
      const result = failure(
        beforeMutation.code,
        beforeMutation.summary,
        beforeMutation.recoverable,
        beforeMutation.details,
      );
      await notifyFailure(input.hooks, event, result);
      return result;
    }
    // `beforeMutation` can await, so repeat both stale-world checks with the
    // exact target/support objects that will be handed to Mineflayer. Do not
    // reuse `finalReference`: it may have become invalid while authorization
    // was being revalidated.
    const clickBefore = readSnapshot(bot, target);
    const clickReference = bot.blockAt(new Vec3(
      reference.position.x,
      reference.position.y,
      reference.position.z,
    ));
    if (!clickBefore || !sameExpected(finalBefore, clickBefore) ||
        !matchesExpected(clickBefore, input.expected) ||
        (!clickBefore.replaceable && !input.allowReplace) ||
        !clickReference ||
        snapshotBlock(clickReference, reference.position).key !== reference.snapshot.key) {
      const result = failure("STALE_STATE", `block changed before placement at ${formatPosition(target)}`, false, {
        before: finalBefore,
        current: clickBefore ?? null,
      });
      await notifyFailure(input.hooks, event, result);
      return result;
    }
    // The authorization callback can await, so check cancellation once more
    // at the last possible point before sending Mineflayer's click.
    if (input.signal.aborted) {
      const result = failure(
        "INTERRUPTED",
        `placement interrupted at ${formatPosition(target)}`,
        true,
        { before: clickBefore },
      );
      await notifyFailure(input.hooks, event, result);
      return result;
    }
    const face = new Vec3(
      reference.faceVector.x,
      reference.faceVector.y,
      reference.faceVector.z,
    );
    if (input.stateful) {
      await bot._placeBlockWithOptions!(clickReference, face, {
        forceLook: "ignore",
        ...(input.stateful.half === undefined ? {} : { half: input.stateful.half }),
      });
    } else {
      await bot.placeBlock(clickReference, face);
    }
    const after = readSnapshot(bot, target);
    if (!after) {
      // The command returned but the chunk is no longer readable, so neither
      // status can be proven. Keep the durable row planned for reconciliation.
      return failure(
        "WORLD_UNAVAILABLE",
        `placement result unavailable at ${formatPosition(target)}`,
        true,
        { before: clickBefore, after: null, intended, journal: "planned" },
      );
    }
    if (!matchesPlacePostcondition(after, input)) {
      const result = failure(
        "STALE_STATE",
        `placement verification failed at ${formatPosition(target)}`,
        true,
        { before: clickBefore, after: after ?? null, intended },
      );
      await notifyPlacementFailure(input.hooks, event, after, result);
      return result;
    }
    verifiedAfter = after;
    try {
      await input.hooks?.applied?.({ ...event, intended: after });
    } catch (error) {
      return failure(
        "UNKNOWN",
        `placed ${input.item} at ${formatPosition(target)}, but could not persist its journal update: ${message(error)}`,
        false,
        { before: clickBefore, after, journalError: message(error) },
      );
    }
    if (input.signal.aborted) {
      return interruptedAfter("place", target, clickBefore, after);
    }
    return {
      ok: true,
      summary: `placed ${input.item} at ${formatPosition(target)}`,
      before: clickBefore,
      after,
      reference: serializableReference,
    };
  } catch (error) {
    const interruptedBySignal = input.signal.aborted || message(error) === "aborted";
    const result = interruptedBySignal
      ? failure("INTERRUPTED", `placement interrupted at ${formatPosition(target)}`, true, { before: liveBefore })
      : failure("UNKNOWN", `could not place ${input.item} at ${formatPosition(target)}: ${message(error)}`, true, {
          before: liveBefore,
        });
    if (!event || verifiedAfter) return result;

    // A rejection after a durable planned entry is ambiguous: Mineflayer may
    // have completed the click before surfacing an error. Re-read before
    // assigning a final journal state.
    const observed = tryReadSnapshot(bot, target);
    if (!observed) {
      return failure(result.code ?? "UNKNOWN", result.summary, result.recoverable ?? true, {
        ...result.details,
        after: null,
        journal: "planned",
      });
    }
    if (matchesPlacePostcondition(observed, input)) {
      try {
        await input.hooks?.applied?.({ ...event, intended: observed });
      } catch (journalError) {
        return failure(
          "UNKNOWN",
          `placed ${input.item} at ${formatPosition(target)}, but could not persist its journal update: ${message(journalError)}`,
          false,
          { before: event.before, after: observed, journalError: message(journalError) },
        );
      }
      if (interruptedBySignal) return interruptedAfter("place", target, event.before, observed);
      return {
        ok: true,
        summary: `placed ${input.item} at ${formatPosition(target)} despite Mineflayer reporting an error`,
        before: event.before,
        after: observed,
        reference: serializableReference,
      };
    }

    // A no-op (including a Mineflayer throw before the click reaches the
    // server) leaves the original observed block intact, so the planned row
    // is an ordinary failed mutation. Only a changed-but-wrong block is a
    // conflict that needs its actual post-click state persisted.
    await notifyPlacementFailure(input.hooks, event, observed, result);
    return result;
  }
}

/** Verified dig with stale-state protection and postcondition confirmation. */
export async function digAt(
  bot: BotLike,
  input: DigAtInput,
): Promise<BlockMutationResult> {
  const target = floorBlockPosition(input.position);
  const before = readSnapshot(bot, target);
  if (!before) return failure("WORLD_UNAVAILABLE", `world data unavailable at ${formatPosition(target)}`, true);
  if (!matchesExpected(before, input.expected)) {
    return failure("STALE_STATE", `block changed before digging at ${formatPosition(target)}`, false, { before });
  }
  if (before.name === "air" || before.name === "cave_air" || before.name === "void_air") {
    return failure("TARGET_UNAVAILABLE", `no diggable block at ${formatPosition(target)}`, false, { before });
  }
  const initialBlock = bot.blockAt(new Vec3(target.x, target.y, target.z));
  if (!initialBlock) return failure("WORLD_UNAVAILABLE", `world data unavailable at ${formatPosition(target)}`, true);
  if (initialBlock.name === "bedrock" || initialBlock.diggable === false) {
    return failure("TARGET_UNAVAILABLE", `block '${initialBlock.name}' cannot be dug at ${formatPosition(target)}`, false, { before });
  }
  if (input.signal.aborted) return interrupted("dig", target, before, { name: "air" }, input.hooks);

  // Mineflayer's canDigBlock includes an interaction-range check. Navigate and
  // refresh first, otherwise distant valid targets are rejected prematurely.
  const reachable = await ensureReachableBlock(bot as never, target, { signal: input.signal });
  if (!reachable.ok) {
    return failure(reachable.code, reachable.summary, reachable.recoverable, reachable.details);
  }
  const reachedBefore = snapshotBlock(reachable.block, target);
  if (!sameExpected(before, reachedBefore) || !matchesExpected(reachedBefore, input.expected)) {
    return failure("STALE_STATE", `block changed while reaching ${formatPosition(target)}`, false, {
      before,
      current: reachedBefore,
    });
  }
  if (reachable.block.name === "bedrock" || reachable.block.diggable === false) {
    return failure("STALE_STATE", `block became undiggable at ${formatPosition(target)}`, false, {
      before: reachedBefore,
    });
  }
  if (bot.canDigBlock?.(reachable.block as BlockLike) === false) {
    return failure("TARGET_UNAVAILABLE", `block is not reachable for digging at ${formatPosition(target)}`, true, {
      before: reachedBefore,
    });
  }

  const tool = bot.pathfinder?.bestHarvestTool?.(reachable.block as BlockLike);
  const inventoryTool = tool
    ? bot.inventory.items().find((item) => item.name === tool.name && item.count > 0)
    : undefined;
  let event: BlockMutationEvent | undefined;
  let verifiedAfter: BlockSnapshot | undefined;
  try {
    if (inventoryTool) await bot.equip(inventoryTool, "hand");
    if (input.signal.aborted) return interrupted("dig", target, before, { name: "air" }, input.hooks);
    const liveBefore = readSnapshot(bot, target);
    if (!liveBefore) return failure("WORLD_UNAVAILABLE", `world data unavailable at ${formatPosition(target)}`, true);
    if (!sameExpected(before, liveBefore) || !matchesExpected(liveBefore, input.expected)) {
      return failure("STALE_STATE", `block changed before digging at ${formatPosition(target)}`, false, {
        before,
        current: liveBefore,
      });
    }
    const liveBlock = bot.blockAt(new Vec3(target.x, target.y, target.z));
    if (!liveBlock || liveBlock.name === "bedrock" || liveBlock.diggable === false) {
      return failure("STALE_STATE", `block became undiggable at ${formatPosition(target)}`, false, {
        before: liveBefore,
      });
    }
    if (bot.canDigBlock?.(liveBlock) === false) {
      return failure("TARGET_UNAVAILABLE", `block is not reachable for digging at ${formatPosition(target)}`, true, {
        before: liveBefore,
      });
    }
    event = {
      action: "dig",
      position: target,
      before: liveBefore,
      intended: { name: "air" },
    };
    const planned = await input.hooks?.planned?.(event);
    if (isHookFailure(planned)) {
      return failure(planned.code, planned.summary, planned.recoverable, planned.details);
    }
    // A persistence callback may await; confirm the exact block one final time
    // before digging rather than trusting the pre-hook object.
    const finalBefore = readSnapshot(bot, target);
    const finalBlock = bot.blockAt(new Vec3(target.x, target.y, target.z));
    if (!finalBefore || !sameExpected(liveBefore, finalBefore) ||
        !matchesExpected(finalBefore, input.expected) || !finalBlock ||
        finalBlock.name === "bedrock" || finalBlock.diggable === false ||
        bot.canDigBlock?.(finalBlock) === false) {
      const result = failure("STALE_STATE", `block changed before digging at ${formatPosition(target)}`, false, {
        before: liveBefore,
        current: finalBefore ?? null,
      });
      await notifyFailure(input.hooks, event, result);
      return result;
    }
    const beforeMutation = await input.hooks?.beforeMutation?.(event);
    if (isHookFailure(beforeMutation)) {
      const result = failure(
        beforeMutation.code,
        beforeMutation.summary,
        beforeMutation.recoverable,
        beforeMutation.details,
      );
      await notifyFailure(input.hooks, event, result);
      return result;
    }
    // Authorization can await. Re-read the exact target and Mineflayer block
    // immediately afterwards, including the live reach predicate, before the
    // dig call uses either object.
    const clickBefore = readSnapshot(bot, target);
    const clickBlock = bot.blockAt(new Vec3(target.x, target.y, target.z));
    if (!clickBefore || !sameExpected(finalBefore, clickBefore) ||
        !matchesExpected(clickBefore, input.expected) || !clickBlock ||
        !sameExpected(clickBefore, snapshotBlock(clickBlock, target)) ||
        clickBlock.name === "bedrock" || clickBlock.diggable === false ||
        bot.canDigBlock?.(clickBlock) === false) {
      const result = failure("STALE_STATE", `block changed before digging at ${formatPosition(target)}`, false, {
        before: finalBefore,
        current: clickBefore ?? null,
      });
      await notifyFailure(input.hooks, event, result);
      return result;
    }
    // `beforeMutation` can await an external authorization check. Do not let
    // a cancellation that raced with it reach Mineflayer's dig call.
    if (input.signal.aborted) {
      const result = failure(
        "INTERRUPTED",
        `dig interrupted at ${formatPosition(target)}`,
        true,
        { before: clickBefore },
      );
      await notifyFailure(input.hooks, event, result);
      return result;
    }
    await digWithAbort(bot, clickBlock, input.signal);
    const after = readSnapshot(bot, target);
    if (!after) {
      return failure(
        "WORLD_UNAVAILABLE",
        `dig result unavailable at ${formatPosition(target)}`,
        true,
        { before: clickBefore, after: null, journal: "planned" },
      );
    }
    if (!isDigPostcondition(clickBefore, after)) {
      const result = failure("STALE_STATE", `dig verification failed at ${formatPosition(target)}`, true, {
        before: clickBefore,
        after,
      });
      await notifyFailure(input.hooks, event, result);
      return result;
    }
    verifiedAfter = after;
    try {
      await input.hooks?.applied?.({ ...event, intended: after });
    } catch (error) {
      return failure(
        "UNKNOWN",
        `dug ${clickBefore.name} at ${formatPosition(target)}, but could not persist its journal update: ${message(error)}`,
        false,
        { before: clickBefore, after, journalError: message(error) },
      );
    }
    if (input.signal.aborted) return interruptedAfter("dig", target, clickBefore, after);
    return {
      ok: true,
      summary: `dug ${clickBefore.name} at ${formatPosition(target)}`,
      before: clickBefore,
      after,
    };
  } catch (error) {
    const interruptedBySignal = input.signal.aborted || message(error) === "aborted";
    const result = interruptedBySignal
      ? failure("INTERRUPTED", `dig interrupted at ${formatPosition(target)}`, true, { before })
      : failure("UNKNOWN", `could not dig ${before.name} at ${formatPosition(target)}: ${message(error)}`, true, { before });
    if (!event || verifiedAfter) return result;

    // A failed/aborted dig after planning is not necessarily a failed world
    // change: Mineflayer can report its error after the server removed the
    // block. Reconcile from the current block before updating the journal.
    const observed = tryReadSnapshot(bot, target);
    if (!observed) {
      return failure(result.code ?? "UNKNOWN", result.summary, result.recoverable ?? true, {
        ...result.details,
        after: null,
        journal: "planned",
      });
    }
    if (isDigPostcondition(event.before, observed)) {
      try {
        await input.hooks?.applied?.({ ...event, intended: observed });
      } catch (journalError) {
        return failure(
          "UNKNOWN",
          `dug ${event.before.name} at ${formatPosition(target)}, but could not persist its journal update: ${message(journalError)}`,
          false,
          { before: event.before, after: observed, journalError: message(journalError) },
        );
      }
      if (interruptedBySignal) return interruptedAfter("dig", target, event.before, observed);
      return {
        ok: true,
        summary: `dug ${event.before.name} at ${formatPosition(target)} despite Mineflayer reporting an error`,
        before: event.before,
        after: observed,
      };
    }

    await notifyFailure(input.hooks, event, result);
    return result;
  }
}

function readSnapshot(bot: BotLike, position: BlockPosition): BlockSnapshot | undefined {
  const block = bot.blockAt(new Vec3(position.x, position.y, position.z));
  return block ? snapshotBlock(block, position) : undefined;
}

/** A reread failure means the journal must remain planned for later recovery. */
function tryReadSnapshot(bot: BotLike, position: BlockPosition): BlockSnapshot | undefined {
  try {
    return readSnapshot(bot, position);
  } catch {
    return undefined;
  }
}

function isDigPostcondition(before: BlockSnapshot, after: BlockSnapshot): boolean {
  return !sameExpected(before, after);
}

/**
 * Mineflayer's dig promise does not consume an AbortSignal. Wire cancellation
 * to its cooperative stop API while retaining the normal forceLook argument.
 */
async function digWithAbort(bot: BotLike, block: BlockLike, signal: AbortSignal): Promise<void> {
  if (signal.aborted) throw new Error("aborted");
  let aborted = false;
  const stop = (): void => {
    aborted = true;
    try {
      bot.stopDigging?.();
    } catch {
      // A best-effort stop must not hide the operation's eventual result.
    }
  };
  signal.addEventListener("abort", stop, { once: true });
  try {
    if (signal.aborted) {
      stop();
      throw new Error("aborted");
    }
    // The second Mineflayer argument is forceLook, never a drop-collection flag.
    await bot.dig(block, true);
    if (aborted || signal.aborted) throw new Error("aborted");
  } finally {
    signal.removeEventListener("abort", stop);
  }
}

/**
 * Mineflayer's ordinary look API has no AbortSignal. Racing the wait keeps a
 * cancelled construction from later reaching its click, while the eventual
 * look completion remains harmless because this invocation has already exited
 * before its journal row is planned.
 */
async function lookWithAbort(bot: BotLike, yaw: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) throw new Error("aborted");
  let rejectAbort!: (reason: Error) => void;
  const aborted = new Promise<never>((_resolve, reject) => {
    rejectAbort = reject;
  });
  const stop = (): void => rejectAbort(new Error("aborted"));
  signal.addEventListener("abort", stop, { once: true });
  try {
    // Wait for Mineflayer's normal look completion so the rotation packet is
    // ordered before the stateful click. `force: true` only updates local
    // bookkeeping and can leave the server using the previous yaw.
    await Promise.race([bot.look!(yaw, 0), aborted]);
  } finally {
    signal.removeEventListener("abort", stop);
  }
}

type IntendedStateResult =
  | { readonly ok: true; readonly intended: IntendedBlockState }
  | { readonly ok: false; readonly summary: string; readonly details: Record<string, unknown> };

/**
 * Keep planned journal states limited to the same observable primitives that
 * `snapshotBlock` and durable transaction normalization understand. Never
 * accept raw state strings, packets, or a dynamic property path here.
 */
function createIntendedState(
  item: string,
  requested: Readonly<Record<string, BlockPropertyValue>> | undefined,
): IntendedStateResult {
  if (requested === undefined) {
    return { ok: true, intended: Object.freeze({ name: item }) };
  }
  if (typeof requested !== "object" || requested === null || Array.isArray(requested)) {
    return {
      ok: false,
      summary: "intended placement properties must be an object",
      details: { item },
    };
  }
  const entries = Object.entries(requested);
  if (entries.length === 0 || entries.length > 32) {
    return {
      ok: false,
      summary: "intended placement properties must contain 1-32 values",
      details: { item, propertyCount: entries.length },
    };
  }
  const properties: Record<string, BlockPropertyValue> = {};
  for (const [key, value] of entries) {
    if (!isSafePropertyKey(key) || !isBlockPropertyValue(value)) {
      return {
        ok: false,
        summary: "intended placement properties contain an unsupported value",
        details: { item, property: key },
      };
    }
    if (typeof value === "string" && value.length > 128) {
      return {
        ok: false,
        summary: "intended placement property strings must be at most 128 characters",
        details: { item, property: key },
      };
    }
    properties[key] = value;
  }
  return {
    ok: true,
    intended: Object.freeze({
      name: item,
      properties: Object.freeze(properties),
    }),
  };
}

function validateStatefulPlacement(
  bot: BotLike,
  stateful: StatefulPlacementOptions | undefined,
  expectedAfter: BlockStatePredicate | undefined,
  intendedProperties: Readonly<Record<string, BlockPropertyValue>> | undefined,
): BlockMutationResult | undefined {
  if (!stateful) return undefined;
  if (!expectedAfter || !intendedProperties) {
    return failure(
      "UNSUPPORTED_STATE",
      "stateful placement requires both intended observable properties and a verified postcondition",
      false,
    );
  }
  if (!Number.isFinite(stateful.yaw)) {
    return failure("UNSUPPORTED_STATE", "stateful placement requires a finite supported player yaw", false);
  }
  if (stateful.half !== undefined && stateful.half !== "top" && stateful.half !== "bottom") {
    return failure("UNSUPPORTED_STATE", "stateful placement requested an unsupported block half", false);
  }
  if (typeof bot.look !== "function" || typeof bot._placeBlockWithOptions !== "function") {
    return failure(
      "UNSUPPORTED_STATE",
      "this Mineflayer runtime cannot perform and verify the requested stateful placement",
      false,
    );
  }
  return undefined;
}

function matchesPlacePostcondition(after: BlockSnapshot, input: PlaceAtInput): boolean {
  if (after.name !== input.item) return false;
  if (!input.expectedAfter) return true;
  try {
    return input.expectedAfter(after);
  } catch {
    // A caller-provided predicate is part of the safety boundary. A throwing
    // predicate cannot prove the desired final state and must fail closed.
    return false;
  }
}

function isBlockPropertyValue(value: unknown): value is BlockPropertyValue {
  return typeof value === "string" || typeof value === "boolean" ||
    (typeof value === "number" && Number.isFinite(value));
}

function isSafePropertyKey(value: string): boolean {
  return /^[a-z][a-z0-9_]{0,63}$/.test(value) &&
    value !== "__proto__" && value !== "constructor" && value !== "prototype";
}

function matchesExpected(snapshot: BlockSnapshot, expected: BlockExpectation | undefined): boolean {
  if (!expected) return true;
  if (typeof expected === "function") return expected(snapshot);
  if ("key" in expected) return snapshot.key === expected.key;
  return snapshot.name === expected.name &&
    snapshot.position.x === expected.position.x &&
    snapshot.position.y === expected.position.y &&
    snapshot.position.z === expected.position.z;
}

function sameExpected(before: BlockSnapshot, current: BlockSnapshot): boolean {
  return before.key === current.key;
}

function serializeReference(reference: PlacementReference): SerializablePlacementReference {
  return {
    direction: reference.face,
    position: { ...reference.position },
    face: { ...reference.faceVector },
  };
}

function failure(
  code: NonNullable<BlockMutationResult["code"]>,
  summary: string,
  recoverable: boolean,
  details?: Record<string, unknown>,
): BlockMutationResult {
  return { ok: false, code, summary, recoverable, details };
}

async function notifyFailure(
  hooks: BlockMutationHooks | undefined,
  event: BlockMutationEvent,
  result: BlockMutationResult,
): Promise<void> {
  if (result.ok) return;
  try {
    await hooks?.failed?.({ ...event, code: result.code ?? "UNKNOWN", summary: result.summary });
  } catch {
    // Journal notification must not overwrite the actual world mutation result.
  }
}

async function notifyConflict(
  hooks: BlockMutationHooks | undefined,
  event: BlockMutationEvent,
  after: BlockSnapshot,
  result: BlockMutationResult,
): Promise<void> {
  if (result.ok) return;
  try {
    await hooks?.conflicted?.({
      ...event,
      after,
      code: result.code ?? "UNKNOWN",
      summary: result.summary,
    });
  } catch {
    // Retain the verified world result even if the journal persistence path
    // itself fails. The planned row then remains reconcilable on reconnect.
  }
}

/**
 * A failed placement verification is only a durable conflict if the world is
 * observably different from the state that was planned. A no-op has no
 * alternate postcondition to preserve and must terminalize as `failed`.
 */
async function notifyPlacementFailure(
  hooks: BlockMutationHooks | undefined,
  event: BlockMutationEvent,
  after: BlockSnapshot,
  result: BlockMutationResult,
): Promise<void> {
  if (sameExpected(event.before, after)) {
    await notifyFailure(hooks, event, result);
    return;
  }
  await notifyConflict(hooks, event, after, result);
}

async function interrupted(
  action: "place" | "dig",
  position: BlockPosition,
  before: BlockSnapshot,
  intended: BlockMutationEvent["intended"],
  hooks: BlockMutationHooks | undefined,
): Promise<BlockMutationResult> {
  const result = failure("INTERRUPTED", `${action} interrupted at ${formatPosition(position)}`, true, { before });
  await notifyFailure(hooks, { action, position, before, intended }, result);
  return result;
}

/** The caller was cancelled, but the durable mutation was positively verified. */
function interruptedAfter(
  action: "place" | "dig",
  position: BlockPosition,
  before: BlockSnapshot,
  after: BlockSnapshot,
): BlockMutationResult {
  return {
    ok: false,
    code: "INTERRUPTED",
    summary: `${action} interrupted at ${formatPosition(position)} after its world change was verified`,
    recoverable: true,
    before,
    after,
    details: { before, after, mutationApplied: true },
  };
}

function formatPosition(position: BlockPosition): string {
  return `${position.x},${position.y},${position.z}`;
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isHookFailure(value: unknown): value is BlockMutationHookFailure {
  return typeof value === "object" && value !== null &&
    (value as { ok?: unknown }).ok === false &&
    typeof (value as { code?: unknown }).code === "string" &&
    typeof (value as { summary?: unknown }).summary === "string" &&
    typeof (value as { recoverable?: unknown }).recoverable === "boolean";
}
