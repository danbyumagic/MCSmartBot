import { z } from "zod";
import type { Bot } from "mineflayer";
import type { ToolDef } from "./tools.js";

const findBlockSchema = z.object({
  name: z
    .string()
    .min(1)
    .max(64)
    .describe("Block name like 'iron_ore', 'oak_log', 'diamond_ore', 'chest'. Vanilla namespace assumed."),
  radius: z
    .number()
    .int()
    .min(1)
    .max(128)
    .default(32)
    .describe("Search radius in blocks. Larger = slower; keep small unless needed."),
  maxResults: z
    .number()
    .int()
    .min(1)
    .max(10)
    .default(3)
    .describe("Stop after finding this many. Default 3."),
  detail: z
    .boolean()
    .default(false)
    .describe(
      "When false (default) returns only the nearest match as a single line. " +
      "Pass true to get all matches up to maxResults.",
    ),
});

function distance(a: { x: number; y: number; z: number }, b: { x: number; y: number; z: number }): number {
  const dx = a.x - b.x, dy = a.y - b.y, dz = a.z - b.z;
  return Math.sqrt(dx * dx + dy * dy + dz * dz);
}

export function createFindBlockTool(bot: Bot): ToolDef<z.infer<typeof findBlockSchema>> {
  return {
    name: "findBlock",
    policy: { minimumRole: "viewer", effect: "read", reversible: false, mission: "forbidden" },
    description:
      "Find the nearest blocks of a given type within a radius. Returns each match's coordinates " +
      "and distance. Use when the owner asks 'where's the nearest X?' or before navigating to a " +
      "specific block. Don't call repeatedly — pick a sensible radius the first time.",
    inputSchema: findBlockSchema,
    handler: async ({ name, radius, maxResults, detail }) => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const registry = (bot as any).registry;
      if (!registry?.blocksByName) {
        return { ok: false, summary: "block registry not available (not spawned?)" };
      }
      const block = registry.blocksByName[name];
      if (!block) {
        return { ok: false, summary: `unknown block name: ${name}` };
      }
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const findBlocks = (bot as any).findBlocks;
      if (typeof findBlocks !== "function") {
        return { ok: false, summary: "bot.findBlocks unavailable" };
      }
      const positions: Array<{ x: number; y: number; z: number }> = findBlocks.call(bot, {
        matching: [block.id],
        maxDistance: radius,
        count: maxResults,
      });
      if (!positions || positions.length === 0) {
        return { ok: true, summary: `no ${name} within ${radius} blocks` };
      }
      const selfPos = bot.entity?.position;
      const self: { x: number; y: number; z: number } = selfPos ?? { x: 0, y: 0, z: 0 };
      if (!detail) {
        // Only return the nearest (first) match
        const p = positions[0] as { x: number; y: number; z: number };
        const d = Math.floor(distance(self, p));
        return { ok: true, summary: `nearest ${name} at ${Math.floor(p.x)} ${Math.floor(p.y)} ${Math.floor(p.z)} (${d}b away)` };
      }
      const lines = positions.map((p) => {
        const d = Math.floor(distance(self, p));
        return `- ${name} at ${Math.floor(p.x)} ${Math.floor(p.y)} ${Math.floor(p.z)} (${d}b)`;
      });
      return { ok: true, summary: `nearest ${name}:\n${lines.join("\n")}` };
    },
  };
}
