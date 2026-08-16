import type { Bot } from "mineflayer";
import { Vec3 } from "vec3";
import type { Reflex } from "../types.js";

const LAVA_BLOCKS = new Set(["lava", "flowing_lava"]);

export function isLavaAdjacent(bot: Bot): boolean {
  if (!bot.entity) return false;
  const p = bot.entity.position;
  const offsets = [
    { x: 1, y: 0, z: 0 },
    { x: -1, y: 0, z: 0 },
    { x: 0, y: 1, z: 0 },
    { x: 0, y: -1, z: 0 },
    { x: 0, y: 0, z: 1 },
    { x: 0, y: 0, z: -1 },
  ];
  for (const o of offsets) {
    // bot.blockAt requires a real Vec3 (it calls .floored() internally). Build
    // one from manually-floored coords so this works with synthetic test bots
    // whose position is a plain object as well as real prismarine-Vec3 positions.
    const target = new Vec3(
      Math.floor(p.x + o.x),
      Math.floor(p.y + o.y),
      Math.floor(p.z + o.z),
    );
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const block = (bot as any).blockAt?.(target);
    if (!block) continue;
    const name = (block.name ?? "").toLowerCase();
    if (LAVA_BLOCKS.has(name)) return true;
  }
  return false;
}

export const avoidLava: Reflex = {
  name: "avoidLava",
  priority: 80,
  check: (bot) => isLavaAdjacent(bot),
  async run(bot, signal) {
    bot.clearControlStates();
    bot.setControlState("back", true);
    try {
      await new Promise<void>((resolve) => {
        const t = setTimeout(resolve, 500);
        signal.addEventListener("abort", () => { clearTimeout(t); resolve(); }, { once: true });
      });
    } finally {
      bot.clearControlStates();
    }
  },
};
