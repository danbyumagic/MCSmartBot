import type { SkillErrorCode } from "../skills/types.js";
import type { BlockPropertyValue, BlockSnapshot } from "./blockSnapshot.js";

/** A serializable integer Minecraft block coordinate. */
export interface BlockPosition {
  readonly x: number;
  readonly y: number;
  readonly z: number;
}

/**
 * A caller-owned postcondition for a world mutation. The executor always also
 * verifies its ordinary block-name postcondition before this predicate runs.
 */
export type BlockStatePredicate = (snapshot: BlockSnapshot) => boolean;

/**
 * The durable portion of an intended post-mutation state. This is deliberately
 * limited to named, observable properties rather than arbitrary state strings
 * or protocol data. It is recorded before Mineflayer performs the mutation so
 * restart reconciliation can reject a same-name but wrong-state block.
 */
export interface IntendedBlockState {
  readonly name: string;
  readonly stateId?: number;
  readonly properties?: Readonly<Record<string, BlockPropertyValue>>;
}

/** Result returned by a verified world mutation, never a live Prismarine Block. */
export interface BlockMutationResult {
  ok: boolean;
  summary: string;
  code?: SkillErrorCode;
  recoverable?: boolean;
  details?: Record<string, unknown>;
  before?: BlockSnapshot;
  after?: BlockSnapshot;
  reference?: {
    direction: string;
    position: BlockPosition;
    face: BlockPosition;
  };
}
