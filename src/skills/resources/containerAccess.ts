import type { Bot } from "mineflayer";
import { Vec3 } from "vec3";
import { goals, pathfindTo } from "../pathfinder.js";
import type { LocationRow } from "../../memory/locations.js";

export interface OpenContainerResult {
  // Mineflayer's Chest/Dispenser types share these operations, while
  // openContainer() may also return version-specific container subclasses.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  container: any;
  blockType: string;
}

export async function openRememberedContainer(
  bot: Bot,
  location: LocationRow,
  signal: AbortSignal,
): Promise<OpenContainerResult> {
  await pathfindTo(
    bot,
    new goals.GoalNear(location.x, location.y, location.z, 2),
    signal,
  );
  if (signal.aborted) throw new Error("aborted");
  const block = bot.blockAt(new Vec3(location.x, location.y, location.z));
  if (!block || !/chest|barrel|shulker_box/.test(block.name ?? "")) {
    throw new Error(`not_container:${block?.name ?? "nothing"}`);
  }
  const container = await bot.openContainer(block);
  return { container, blockType: block.name };
}

export function snapshotItems(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  container: any,
): Array<{ item: string; itemType: number; metadata: number; count: number }> {
  const items = (container.containerItems?.() ?? []) as Array<{
    name?: string;
    type?: number;
    metadata?: number;
    count?: number;
  }>;
  return items
    .filter((item) =>
      Boolean(item?.name) &&
      typeof item.type === "number" &&
      typeof item.count === "number" &&
      item.count > 0,
    )
    .map((item) => ({
      item: item.name!,
      itemType: item.type!,
      metadata: item.metadata ?? 0,
      count: item.count!,
    }));
}
