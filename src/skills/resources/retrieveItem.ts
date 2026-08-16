import { z } from "zod";
import type { DB } from "../../memory/db.js";
import {
  findContainersWithItem,
  replaceContainerSnapshot,
  type IndexedContainerItem,
} from "../../memory/containers.js";
import { getLocation } from "../../memory/locations.js";
import { countInInventory } from "../helpers.js";
import { defineSkill, type SkillDefinition } from "../types.js";
import { openRememberedContainer, snapshotItems } from "./containerAccess.js";

const params = z.object({
  item: z.string().min(1).max(64).describe("Exact vanilla item name"),
  quantity: z.number().int().min(1).max(256).describe("Target total count in bot inventory"),
  chestName: z.string().min(1).max(64).optional().describe("Optional indexed container to restrict retrieval to"),
  excludeChestName: z.string().min(1).max(64).optional().describe(
    "Optional container to exclude, useful when supplying a destination container",
  ),
});

export function retrieveItem(db: DB): SkillDefinition<z.infer<typeof params>> {
  return defineSkill({
    name: "retrieveItem",
    policy: { minimumRole: "operator", effect: "inventory", reversible: false, mission: "public" },
    description:
      "Retrieve an exact item from indexed containers until the requested inventory total is reached. " +
      "Without chestName, searches all indexed containers and verifies their live contents.",
    params,
    async run({ item, quantity, chestName, excludeChestName }, ctx) {
      if (!ctx.bot.registry?.itemsByName?.[item]) {
        return {
          ok: false, summary: `unknown item name: ${item}`,
          code: "INVALID_PARAMS", recoverable: false, details: { item },
        };
      }
      const initial = countInInventory(ctx.bot, item);
      if (initial >= quantity) {
        return { ok: true, summary: `already have ${initial} ${item} (target was ${quantity})` };
      }

      let candidates = findContainersWithItem(db, item);
      if (chestName) candidates = candidates.filter((candidate) => candidate.name === chestName);
      if (excludeChestName) {
        candidates = candidates.filter((candidate) => candidate.name !== excludeChestName);
      }
      if (candidates.length === 0) {
        return {
          ok: false,
          summary: chestName
            ? `no indexed ${item} in '${chestName}'`
            : `no indexed containers contain ${item}`,
          code: "NO_MATERIAL",
          recoverable: true,
          details: {
            item,
            chestName: chestName ?? null,
            excludeChestName: excludeChestName ?? null,
            indexMissing: true,
          },
        };
      }

      let current = initial;
      const visited: string[] = [];
      for (const candidate of candidates) {
        if (current >= quantity) break;
        if (ctx.signal.aborted) {
          return interrupted(item, current, quantity, visited);
        }
        const location = getLocation(db, candidate.name);
        if (!location) continue;
        let opened;
        try {
          opened = await openRememberedContainer(ctx.bot, location, ctx.signal);
        } catch (err) {
          const message = (err as Error).message ?? String(err);
          if (message === "aborted") return interrupted(item, current, quantity, visited);
          ctx.log.debug({ container: candidate.name, message }, "could not open indexed container");
          continue;
        }
        visited.push(candidate.name);
        try {
          const liveItems = snapshotItems(opened.container);
          const matching = liveItems.filter((entry) => entry.item === item);
          const liveCount = matching.reduce((sum, entry) => sum + entry.count, 0);
          const wanted = Math.min(quantity - current, liveCount);
          if (wanted > 0) {
            const source = matching[0]!;
            await opened.container.withdraw(source.itemType, source.metadata, wanted);
            current = countInInventory(ctx.bot, item);
          }
          replaceContainerSnapshot(db, {
            name: candidate.name,
            dimension: location.dimension,
            x: location.x,
            y: location.y,
            z: location.z,
            blockType: opened.blockType,
            items: snapshotItems(opened.container),
          });
        } catch (err) {
          const message = (err as Error).message ?? String(err);
          ctx.log.debug({ container: candidate.name, message }, "container retrieval failed");
        } finally {
          try {
            opened.container.close();
          } catch {
            // ignore close errors
          }
        }
      }

      const retrieved = Math.max(0, current - initial);
      if (current < quantity) {
        return {
          ok: false,
          summary: `retrieved ${retrieved} ${item} but only have ${current}/${quantity}`,
          code: "NO_MATERIAL",
          recoverable: true,
          details: { item, retrieved, current, target: quantity, visited },
        };
      }
      return {
        ok: true,
        summary: `retrieved ${retrieved} ${item} (now have ${current})`,
        data: { item, retrieved, total: current, target: quantity, visited },
      };
    },
  });
}

function interrupted(
  item: string,
  current: number,
  target: number,
  visited: string[],
) {
  return {
    ok: false as const,
    summary: `retrieveItem cancelled at ${current}/${target} ${item}`,
    code: "INTERRUPTED" as const,
    recoverable: true,
    details: { item, current, target, visited },
  };
}
