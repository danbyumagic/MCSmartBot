import pathfinderPkg from "mineflayer-pathfinder";
import type { Reflex } from "../types.js";
import type { DB } from "../../memory/db.js";
import { getLocation } from "../../memory/locations.js";
import { pathfindTo } from "../../skills/pathfinder.js";
import { resolveOnlinePlayer } from "../../bot/playerIdentity.js";

const { goals } = pathfinderPkg;

export interface FleeOnLowHpDeps {
  db: DB;
  ownerUsername: string;
  hpThreshold: number;
}

export function fleeOnLowHp(deps: FleeOnLowHpDeps): Reflex {
  return {
    name: "fleeOnLowHp",
    priority: 90,
    check: (bot) => {
      if (typeof bot.health !== "number") return false;
      return bot.health < deps.hpThreshold;
    },
    async run(bot, signal) {
      const safe = getLocation(deps.db, "safe_spot");
      let target: { x: number; y: number; z: number } | null = null;
      if (safe) {
        target = { x: safe.x, y: safe.y, z: safe.z };
      } else {
        const ownerPos = resolveOnlinePlayer(bot, deps.ownerUsername)?.player.entity?.position;
        if (ownerPos) target = { x: ownerPos.x, y: ownerPos.y, z: ownerPos.z };
      }
      if (!target) {
        // Last resort: sprint forward briefly.
        bot.setControlState("sprint", true);
        bot.setControlState("forward", true);
        try {
          await new Promise<void>((resolve) => {
            const t = setTimeout(resolve, 2000);
            signal.addEventListener("abort", () => { clearTimeout(t); resolve(); }, { once: true });
          });
        } finally {
          bot.clearControlStates();
        }
        return;
      }
      const goal = new goals.GoalNear(target.x, target.y, target.z, 2);
      try {
        await pathfindTo(bot, goal, signal);
      } catch {
        // pathfinding aborted (signal) or no path; either is fine — just stop trying.
      }
    },
  };
}
