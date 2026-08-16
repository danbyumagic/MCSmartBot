import { goals, pathfindTo } from "../pathfinder.js";
import type { SkillContext } from "../types.js";
import type { BlockPosition } from "../../world/types.js";

interface DropCandidate {
  readonly id: string;
  readonly position: BlockPosition;
  readonly distance: number;
}

export interface DropPickupReport {
  readonly enabled: boolean;
  readonly observed: number;
  /** Drops the bot successfully walked to; Mineflayer owns final auto-pickup. */
  readonly approached: number;
  readonly unreachable: number;
  readonly interrupted: boolean;
}

/** Snapshot nearby item entities before a dig so unrelated drops are not chased. */
export function nearbyDropIds(bot: SkillContext["bot"], origin: BlockPosition): ReadonlySet<string> {
  return new Set(findDrops(bot, origin).map((drop) => drop.id));
}

/**
 * Mineflayer's `dig` option is force-look, not a collect-drops switch. After a
 * verified dig, this makes a bounded best-effort walk to newly observed item
 * entities. It reports only what it observed/approached, never claims an
 * unverifiable inventory pickup.
 */
export async function collectNewDrops(
  ctx: SkillContext,
  origin: BlockPosition,
  before: ReadonlySet<string>,
): Promise<DropPickupReport> {
  if (ctx.signal.aborted) {
    return Object.freeze({ enabled: true, observed: 0, approached: 0, unreachable: 0, interrupted: true });
  }
  const candidates = findDrops(ctx.bot, origin)
    .filter((drop) => !before.has(drop.id))
    .slice(0, 8);
  let approached = 0;
  let unreachable = 0;
  for (const drop of candidates) {
    if (ctx.signal.aborted) {
      return Object.freeze({
        enabled: true,
        observed: candidates.length,
        approached,
        unreachable,
        interrupted: true,
      });
    }
    try {
      await pathfindTo(
        ctx.bot,
        new goals.GoalNear(drop.position.x, drop.position.y, drop.position.z, 1),
        ctx.signal,
      );
      approached++;
    } catch {
      unreachable++;
    }
  }
  return Object.freeze({
    enabled: true,
    observed: candidates.length,
    approached,
    unreachable,
    interrupted: ctx.signal.aborted,
  });
}

function findDrops(bot: SkillContext["bot"], origin: BlockPosition): DropCandidate[] {
  const entities = bot.entities ?? {};
  const drops: DropCandidate[] = [];
  for (const [fallbackId, entity] of Object.entries(entities)) {
    if (!entity || entity.name !== "item" || !entity.position) continue;
    const x = entity.position.x;
    const y = entity.position.y;
    const z = entity.position.z;
    if (![x, y, z].every(Number.isFinite)) continue;
    const dx = x - (origin.x + 0.5);
    const dy = y - (origin.y + 0.5);
    const dz = z - (origin.z + 0.5);
    const distance = Math.sqrt(dx * dx + dy * dy + dz * dz);
    if (distance > 6) continue;
    drops.push(Object.freeze({
      id: String(entity.id ?? fallbackId),
      position: Object.freeze({ x: Math.floor(x), y: Math.floor(y), z: Math.floor(z) }),
      distance,
    }));
  }
  return drops.sort((left, right) => left.distance - right.distance || left.id.localeCompare(right.id));
}
