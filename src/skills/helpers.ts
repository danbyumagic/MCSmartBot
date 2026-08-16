import type { Bot } from "mineflayer";
import { Vec3 } from "vec3";

/** Sum the count of items matching `name` across all inventory stacks. */
export function countInInventory(bot: Bot, name: string): number {
  let total = 0;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const items = (bot.inventory as any)?.items?.() ?? [];
  for (const item of items) {
    if (item && item.name === name) {
      total += typeof item.count === "number" ? item.count : 1;
    }
  }
  return total;
}

/**
 * Find the nearest block of a given name within `radius`. Returns the block
 * object (with `.position` and `.name`) or null. Resolves the block name via
 * `bot.registry.blocksByName` to get the numeric id, then calls `bot.findBlock`.
 */
export function findNearestBlockByName(
  bot: Bot,
  name: string,
  radius: number,
): { name: string; position: Vec3 } | null {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const registry = (bot as any).registry;
  const data = registry?.blocksByName?.[name];
  if (!data) return null;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const found = (bot as any).findBlock?.({ matching: [data.id], maxDistance: radius });
  if (!found) return null;
  return { name, position: found.position };
}

/**
 * Find all the connected log blocks of a tree, given any starting log block.
 * Floods 6-connected (covers vertical trunks and side branches) until no more
 * matching log is adjacent or `maxBlocks` is reached. Used by `chopTrees`.
 */
export function findConnectedLogs(
  bot: Bot,
  start: Vec3,
  logName: string,
  maxBlocks: number = 32,
): Vec3[] {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const blockAt = (bot as any).blockAt;
  if (typeof blockAt !== "function") return [];
  const seen = new Set<string>();
  const queue: Vec3[] = [start];
  const found: Vec3[] = [];
  while (queue.length > 0 && found.length < maxBlocks) {
    const pos = queue.shift()!;
    const key = `${pos.x},${pos.y},${pos.z}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const block = blockAt.call(bot, pos);
    if (!block || block.name !== logName) continue;
    found.push(pos);
    for (const [dx, dy, dz] of [
      [1, 0, 0], [-1, 0, 0],
      [0, 1, 0], [0, -1, 0],
      [0, 0, 1], [0, 0, -1],
    ] as const) {
      queue.push(new Vec3(pos.x + dx, pos.y + dy, pos.z + dz));
    }
  }
  return found;
}
