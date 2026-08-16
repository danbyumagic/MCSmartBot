import { z } from "zod";
import type { DB } from "../../memory/db.js";
import { replaceContainerSnapshot } from "../../memory/containers.js";
import { getLocation } from "../../memory/locations.js";
import { defineSkill, type SkillDefinition } from "../types.js";
import { openRememberedContainer, snapshotItems } from "./containerAccess.js";

const params = z.object({
  chestName: z.string().min(1).max(64).describe("Remembered name of a chest, barrel, or shulker box"),
});

export function scanContainer(db: DB): SkillDefinition<z.infer<typeof params>> {
  return defineSkill({
    name: "scanContainer",
    policy: { minimumRole: "operator", effect: "read", reversible: false, mission: "public" },
    description:
      "Open a remembered container and persist a current item index. " +
      "Use after remembering a storage location or when its index may be stale.",
    params,
    async run({ chestName }, ctx) {
      const location = getLocation(db, chestName);
      if (!location) {
        return {
          ok: false,
          summary: `no location named '${chestName}'`,
          code: "NOT_CONFIGURED",
          recoverable: true,
          details: { requiredLocation: chestName },
        };
      }

      let opened;
      try {
        opened = await openRememberedContainer(ctx.bot, location, ctx.signal);
      } catch (err) {
        const message = (err as Error).message ?? String(err);
        const interrupted = message === "aborted";
        return {
          ok: false,
          summary: interrupted ? `scanContainer ${chestName} cancelled` : `could not scan '${chestName}': ${message}`,
          code: interrupted ? "INTERRUPTED" : message.startsWith("not_container:") ? "TARGET_UNAVAILABLE" : "NO_PATH",
          recoverable: true,
          details: { chestName, message },
        };
      }

      try {
        const items = snapshotItems(opened.container);
        replaceContainerSnapshot(db, {
          name: chestName,
          dimension: location.dimension,
          x: location.x,
          y: location.y,
          z: location.z,
          blockType: opened.blockType,
          items,
        });
        const total = items.reduce((sum, item) => sum + item.count, 0);
        return {
          ok: true,
          summary: `indexed '${chestName}': ${items.length} item types ${total} items`,
          data: { chestName, itemTypes: items.length, total },
        };
      } finally {
        try {
          opened.container.close();
        } catch {
          // ignore close errors
        }
      }
    },
  });
}
