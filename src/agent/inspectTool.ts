import { z } from "zod";
import type { Bot } from "mineflayer";
import type { ToolDef } from "./tools.js";
import {
  resolveOnlinePlayer,
  sameMinecraftUsername,
} from "../bot/playerIdentity.js";

const inspectSchema = z.object({
  what: z
    .enum(["self", "owner", "nearby", "server", "players"])
    .default("self")
    .describe(
      "Subject to inspect: 'self' for the bot's own state, 'owner' for the owner's position, " +
      "'nearby' for a list of players in render range with distances, " +
      "'server' for server brand/gamemode/difficulty/time/weather, " +
      "'players' for all connected players with ping and gamemode.",
    ),
  detail: z
    .boolean()
    .default(false)
    .describe(
      "When false (default) returns a terse one-liner. Pass true only when the owner explicitly " +
      "asks for full details or when the summary genuinely doesn't have enough info to act.",
    ),
});

function formatCoords(p: { x: number; y: number; z: number }): string {
  return `${Math.floor(p.x)} ${Math.floor(p.y)} ${Math.floor(p.z)}`;
}

function distance(a: { x: number; y: number; z: number }, b: { x: number; y: number; z: number }): number {
  const dx = a.x - b.x, dy = a.y - b.y, dz = a.z - b.z;
  return Math.sqrt(dx * dx + dy * dy + dz * dz);
}

export function createInspectTool(bot: Bot, ownerUsername: string): ToolDef<z.infer<typeof inspectSchema>> {
  return {
    name: "inspect",
    policy: { minimumRole: "viewer", effect: "read", reversible: false, mission: "forbidden" },
    description:
      "Report the bot's state, the owner's position, or nearby players. " +
      "Call this before any skill that needs coordinates (e.g., gotoCoords near owner, " +
      "rememberLocation when you don't know where you are).",
    inputSchema: inspectSchema,
    handler: async ({ what, detail }) => {
      if (!bot.entity) {
        return { ok: false, summary: "not yet spawned in the world" };
      }
      const self = bot.entity.position;

      if (what === "self") {
        if (!detail) {
          const hp = bot.health ?? "?";
          const food = bot.food ?? "?";
          const pos = formatCoords(self);
          const dim = (bot as unknown as { game?: { dimension?: string } }).game?.dimension
            ?.replace(/^minecraft:/, "") ?? "unknown";
          return { ok: true, summary: `hp ${hp}/20, food ${food}/20, pos ${pos}, ${dim}` };
        }
        const parts = [
          `pos ${formatCoords(self)}`,
          `hp ${bot.health ?? "?"}`,
          `food ${bot.food ?? "?"}`,
        ];
        const dim = (bot as unknown as { game?: { dimension?: string } }).game?.dimension;
        if (dim) parts.push(`dim ${dim.replace(/^minecraft:/, "")}`);
        const time = (bot as unknown as { time?: { timeOfDay?: number } }).time?.timeOfDay;
        if (typeof time === "number") {
          parts.push(`time ${time} (${time < 12000 ? "day" : "night"})`);
        }
        if ((bot as unknown as { isRaining?: boolean }).isRaining) parts.push("raining");
        return { ok: true, summary: parts.join(", ") };
      }

      if (what === "owner") {
        const resolved = resolveOnlinePlayer(bot, ownerUsername);
        if (!resolved) return { ok: false, summary: `${ownerUsername} is not online` };
        if (!resolved.player.entity) return { ok: false, summary: `${resolved.username} is online but no entity in render range` };
        const d = Math.floor(distance(self, resolved.player.entity.position));
        if (!detail) {
          return { ok: true, summary: `${resolved.username} ${d}b away at ${formatCoords(resolved.player.entity.position)}` };
        }
        return { ok: true, summary: `${resolved.username} at ${formatCoords(resolved.player.entity.position)} (${d} blocks away)` };
      }

      // what === "nearby"
      if (what === "nearby") {
        const entries: Array<{ name: string; pos: { x: number; y: number; z: number }; d: number }> = [];
        for (const [name, p] of Object.entries(bot.players)) {
          if (sameMinecraftUsername(name, bot.username)) continue;
          if (!p.entity) continue;
          entries.push({ name, pos: p.entity.position, d: distance(self, p.entity.position) });
        }
        entries.sort((a, b) => a.d - b.d);
        if (entries.length === 0) return { ok: true, summary: "no players in render range" };
        if (!detail) {
          return { ok: true, summary: `${entries.length} player${entries.length === 1 ? "" : "s"} in range` };
        }
        const lines = entries.slice(0, 10).map((e) => `- ${e.name} at ${formatCoords(e.pos)} (${Math.floor(e.d)}b)`);
        return { ok: true, summary: `nearby:\n${lines.join("\n")}` };
      }

      if (what === "server") {
        const game = (bot as unknown as {
          game?: {
            serverBrand?: string;
            gameMode?: string;
            difficulty?: string;
            levelType?: string;
            viewDistance?: number;
            dimension?: string;
          };
        }).game;
        const time = (bot as unknown as { time?: { timeOfDay?: number } }).time?.timeOfDay;
        const isRaining = (bot as unknown as { isRaining?: boolean }).isRaining;
        if (!detail) {
          const brand = game?.serverBrand ?? "unknown";
          const gm = game?.gameMode ?? "unknown";
          const diff = game?.difficulty ?? "unknown";
          return { ok: true, summary: `${brand}, ${gm}, ${diff}` };
        }
        const parts: string[] = [];
        if (game?.serverBrand) parts.push(`brand: ${game.serverBrand}`);
        if (game?.gameMode) parts.push(`gamemode: ${game.gameMode}`);
        if (game?.difficulty) parts.push(`difficulty: ${game.difficulty}`);
        if (game?.levelType) parts.push(`level type: ${game.levelType}`);
        if (game?.viewDistance) parts.push(`view distance: ${game.viewDistance}`);
        if (typeof time === "number") parts.push(`time: ${time} (${time < 12000 ? "day" : "night"})`);
        if (isRaining) parts.push("weather: raining");
        else parts.push("weather: clear");
        if (parts.length === 0) return { ok: false, summary: "server info not yet available" };
        return { ok: true, summary: parts.join(", ") };
      }

      // what === "players"
      const allPlayers = Object.entries(bot.players)
        .filter(([name]) => !sameMinecraftUsername(name, bot.username))
        .sort(([a], [b]) => a.localeCompare(b));
      if (allPlayers.length === 0) return { ok: true, summary: "no players connected" };
      if (!detail) {
        const names = allPlayers.map(([name]) => name).join(", ");
        return { ok: true, summary: `${allPlayers.length} online: ${names}` };
      }
      const lines = allPlayers.map(([name, p]) => {
        const ping = (p as unknown as { ping?: number }).ping;
        const gm = (p as unknown as { gamemode?: string | number }).gamemode;
        let line = `- ${name}`;
        if (typeof ping === "number") line += ` (${ping}ms)`;
        if (gm !== undefined && gm !== null) line += ` gamemode:${gm}`;
        if (p.entity) {
          const d = Math.floor(distance(self, p.entity.position));
          line += ` ${d}b away`;
        }
        return line;
      });
      return { ok: true, summary: `players (${allPlayers.length}):\n${lines.join("\n")}` };
    },
  };
}
