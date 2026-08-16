import { Vec3 } from "vec3";
import { snapshotBlock, type BlockSnapshot } from "../blockSnapshot.js";
import type { BlockPosition } from "../types.js";

/**
 * The narrow Mineflayer boundary used by reconnect reconciliation. Journal
 * positions are plain immutable data, whereas Mineflayer requires Vec3 with
 * its runtime helpers (notably `floored()`) for `blockAt`.
 */
export function inspectJournalBlock(
  bot: {
    blockAt(position: Vec3): Parameters<typeof snapshotBlock>[0] | null | undefined;
  },
  position: BlockPosition,
): BlockSnapshot | null {
  const block = bot.blockAt(new Vec3(position.x, position.y, position.z));
  return block ? snapshotBlock(block, position) : null;
}
