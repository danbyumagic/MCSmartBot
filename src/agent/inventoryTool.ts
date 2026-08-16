import { z } from "zod";
import type { Bot } from "mineflayer";
import {
  checkInventoryRequirements,
  createInventorySnapshot,
  formatEquipment,
  formatItem,
} from "../inventory/snapshot.js";
import type { ToolDef } from "./tools.js";

const inventorySchema = z.object({
  view: z
    .enum(["summary", "all", "hotbar", "held", "equipment"])
    .default("summary")
    .describe(
      "Which inventory slice to inspect. Use summary for capacity and a compact overview, " +
      "equipment for armor/offhand, or all for carried stacks.",
    ),
  detail: z
    .boolean()
    .default(false)
    .describe(
      "Include exact counts, durability, enchantments, and slot usage. Prefer false unless " +
      "the exact inventory contents are needed.",
    ),
  requirements: z
    .array(z.object({
      item: z.string().min(1).describe("Exact Minecraft item name, such as oak_planks."),
      quantity: z.number().int().positive(),
    }))
    .optional()
    .describe(
      "Optional item requirements to check. Use this before gathering, crafting, building, " +
      "or equipping so shortages are explicit.",
    ),
});

export function createInventoryTool(bot: Bot): ToolDef<z.infer<typeof inventorySchema>> {
  return {
    name: "inventory",
    policy: { minimumRole: "viewer", effect: "read", reversible: false, mission: "forbidden" },
    description:
      "Inspect carried items, capacity, hotbar, held item, armor, offhand, durability, and " +
      "enchantments. Also checks exact material requirements. Use it before gathering, " +
      "crafting, building, or equipping whenever the live inventory context is insufficient.",
    inputSchema: inventorySchema,
    handler: async ({ view, detail, requirements }) => {
      const snapshot = createInventorySnapshot(bot);
      if (!snapshot.available) {
        return {
          ok: false,
          summary: "inventory not yet available (not spawned?)",
          code: "TARGET_UNAVAILABLE",
          recoverable: true,
        };
      }

      let summary: string;
      switch (view) {
        case "held":
          summary = snapshot.held ? `held: ${formatItem(snapshot.held)}` : "held: nothing";
          break;
        case "equipment":
          summary = formatEquipment(snapshot);
          break;
        case "hotbar":
          if (!detail) {
            summary = `hotbar has ${snapshot.hotbar.length} item${snapshot.hotbar.length === 1 ? "" : "s"}`;
          } else {
            summary = `hotbar: ${formatItemList(snapshot.hotbar)}`;
          }
          break;
        case "all":
          if (!detail) {
            if (snapshot.totals.length === 0) {
              summary = "inventory: empty";
            } else {
              const samples = snapshot.totals.slice(0, 3).map((item) => item.name).join(", ");
              summary =
                `${snapshot.totals.length} unique item${snapshot.totals.length === 1 ? "" : "s"}, ` +
                `including ${samples}`;
            }
          } else {
            summary = `inventory: ${snapshot.totals.length > 0
              ? snapshot.totals.map((item) => `${item.count} ${item.name}`).join(", ")
              : "empty"}`;
          }
          break;
        case "summary":
          summary = formatSummary(snapshot, detail);
          break;
      }

      const statuses = requirements
        ? checkInventoryRequirements(snapshot, requirements)
        : [];
      if (statuses.length > 0) {
        const requirementText = statuses.map((status) =>
          status.satisfied
            ? `${status.item}: ${status.have}/${status.quantity} ready`
            : `${status.item}: ${status.have}/${status.quantity}, missing ${status.missing}`,
        ).join("; ");
        summary += ` | requirements: ${requirementText}`;
      }

      return {
        ok: true,
        summary,
        details: statuses.length > 0
          ? {
              requirements: statuses,
              ready: statuses.every((status) => status.satisfied),
            }
          : {
              usedSlots: snapshot.usedSlots,
              capacity: snapshot.capacity,
              freeSlots: snapshot.freeSlots,
            },
      };
    },
  };
}

function formatSummary(
  snapshot: ReturnType<typeof createInventorySnapshot>,
  detail: boolean,
): string {
  const slotSummary =
    `inventory ${snapshot.usedSlots}/${snapshot.capacity} slots ` +
    `(${snapshot.freeSlots} free)`;
  const carried = snapshot.totals.length > 0
    ? snapshot.totals
      .slice(0, detail ? snapshot.totals.length : 5)
      .map((item) => `${item.count} ${item.name}`)
      .join(", ")
    : "empty";
  const held = snapshot.held ? formatItem(snapshot.held) : "nothing";
  const warnings = snapshot.nearBreaking.length > 0
    ? ` | low durability: ${snapshot.nearBreaking.map(formatItem).join(", ")}`
    : "";
  return `${slotSummary} | carried: ${carried} | held: ${held} | ${formatEquipment(snapshot)}${warnings}`;
}

function formatItemList(
  items: ReturnType<typeof createInventorySnapshot>["hotbar"],
): string {
  return items.length > 0 ? items.map(formatItem).join(", ") : "empty";
}
