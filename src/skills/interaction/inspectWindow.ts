import { z } from "zod";
import { defineSkill } from "../types.js";

const MAX_INSPECTED_SLOTS = 128;
const MAX_WINDOW_SLOTS = 4_096;
const MAX_ITEM_NAME_LENGTH = 128;
const MAX_WINDOW_TEXT_LENGTH = 256;

export interface WindowItemSummary {
  readonly name: string;
  readonly count: number;
  readonly type?: number;
  readonly metadata?: number;
}

export interface WindowSlotSummary {
  readonly slot: number;
  readonly item: WindowItemSummary | null;
}

export interface WindowSummary {
  readonly type: string | number;
  readonly title: string;
  readonly slotCount: number;
  readonly truncated: boolean;
  readonly slots: readonly WindowSlotSummary[];
  readonly cursor: WindowItemSummary | null;
}

/**
 * Convert Mineflayer's mutable Window/Item objects into a deliberately small,
 * serializable DTO. NBT, custom display data, callbacks, and protocol details
 * are intentionally not exposed through direct skills.
 */
export function summarizeWindow(window: unknown, maxSlots = MAX_INSPECTED_SLOTS): WindowSummary | null {
  if (typeof window !== "object" || window === null) return null;
  const candidate = window as {
    type?: unknown;
    title?: unknown;
    slots?: unknown;
    selectedItem?: unknown;
  };
  if (!Array.isArray(candidate.slots)) return null;

  const requestedSlots = Number.isFinite(maxSlots) ? Math.floor(maxSlots) : MAX_INSPECTED_SLOTS;
  const slotLimit = Math.max(0, Math.min(MAX_INSPECTED_SLOTS, requestedSlots));
  const slots = candidate.slots
    .slice(0, slotLimit)
    .map((item, slot) => ({ slot, item: summarizeWindowItem(item) }));
  const type = typeof candidate.type === "string"
    ? candidate.type.slice(0, MAX_WINDOW_TEXT_LENGTH)
    : typeof candidate.type === "number" && Number.isFinite(candidate.type)
      ? candidate.type
      : "unknown";
  const title = typeof candidate.title === "string"
    ? candidate.title.slice(0, MAX_WINDOW_TEXT_LENGTH)
    : "";

  return {
    type,
    title,
    slotCount: Math.min(candidate.slots.length, MAX_WINDOW_SLOTS),
    truncated: candidate.slots.length > slotLimit,
    slots,
    cursor: summarizeWindowItem(candidate.selectedItem),
  };
}

/** Return only stable primitive item data from one Mineflayer Window slot. */
export function summarizeWindowItem(item: unknown): WindowItemSummary | null {
  if (typeof item !== "object" || item === null) return null;
  const candidate = item as {
    name?: unknown;
    count?: unknown;
    type?: unknown;
    metadata?: unknown;
  };
  if (typeof candidate.name !== "string" || candidate.name.length === 0) return null;
  const count = typeof candidate.count === "number" && Number.isFinite(candidate.count)
    ? Math.max(0, Math.min(2_304, Math.floor(candidate.count)))
    : 1;
  const type = finiteInteger(candidate.type);
  const metadata = finiteInteger(candidate.metadata);
  return {
    name: candidate.name.slice(0, MAX_ITEM_NAME_LENGTH),
    count,
    ...(type === undefined ? {} : { type }),
    ...(metadata === undefined ? {} : { metadata }),
  };
}

/** Comparison is performed on sanitized values, never Mineflayer Item references. */
export function sameWindowItem(
  first: WindowItemSummary | null,
  second: WindowItemSummary | null,
): boolean {
  return first?.name === second?.name &&
    first?.count === second?.count &&
    first?.type === second?.type &&
    first?.metadata === second?.metadata;
}

export const inspectWindow = defineSkill({
  name: "inspectWindow",
  policy: { minimumRole: "operator", effect: "read", reversible: false, mission: "public" },
  description:
    "Inspect the currently open Minecraft window using bounded, sanitized slot summaries. " +
    "Does not expose raw window objects, packets, NBT, or callbacks.",
  params: z.object({}),
  async run(_params, ctx) {
    if (ctx.signal.aborted) return interrupted();
    const window = summarizeWindow(ctx.bot.currentWindow);
    if (!window) {
      return {
        ok: false,
        summary: "no Minecraft window is currently open",
        code: "TARGET_UNAVAILABLE",
        recoverable: true,
      };
    }
    return {
      ok: true,
      summary: `inspected ${window.type} window with ${window.slotCount} slots`,
      data: { window },
    };
  },
});

function finiteInteger(value: unknown): number | undefined {
  return typeof value === "number" && Number.isSafeInteger(value) ? value : undefined;
}

function interrupted() {
  return {
    ok: false,
    summary: "window inspection interrupted",
    code: "INTERRUPTED" as const,
    recoverable: true,
  };
}
