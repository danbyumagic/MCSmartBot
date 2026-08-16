import type { Bot, EquipmentDestination } from "mineflayer";

export interface InventoryItemSnapshot {
  name: string;
  count: number;
  slot: number | null;
  customName: string | null;
  durability: {
    remaining: number;
    maximum: number;
    percent: number;
  } | null;
  enchantments: Array<{ name: string; level: number }>;
}

export interface InventoryRequirement {
  item: string;
  quantity: number;
}

export interface InventoryRequirementStatus extends InventoryRequirement {
  have: number;
  missing: number;
  satisfied: boolean;
}

export interface InventorySnapshot {
  available: boolean;
  carried: InventoryItemSnapshot[];
  totals: Array<{ name: string; count: number }>;
  hotbar: InventoryItemSnapshot[];
  held: InventoryItemSnapshot | null;
  equipment: {
    head: InventoryItemSnapshot | null;
    torso: InventoryItemSnapshot | null;
    legs: InventoryItemSnapshot | null;
    feet: InventoryItemSnapshot | null;
    offHand: InventoryItemSnapshot | null;
  };
  capacity: number;
  usedSlots: number;
  freeSlots: number;
  nearBreaking: InventoryItemSnapshot[];
}

type ItemLike = {
  name?: string | null;
  count?: number | null;
  slot?: number | null;
  customName?: string | null;
  maxDurability?: number | null;
  durabilityUsed?: number | null;
  enchants?: Array<{ name?: string | null; lvl?: number | null }>;
};

const FALLBACK_EQUIPMENT_SLOTS: Record<
  Exclude<EquipmentDestination, "hand">,
  number
> = {
  head: 5,
  torso: 6,
  legs: 7,
  feet: 8,
  "off-hand": 45,
};

export function createInventorySnapshot(bot: Bot): InventorySnapshot {
  const inventory = (bot as Bot & {
    inventory?: {
      items?: () => ItemLike[];
      slots?: Array<ItemLike | null | undefined>;
      inventoryStart?: number;
      inventoryEnd?: number;
    };
  }).inventory;
  if (!inventory?.items) return emptySnapshot();

  const carriedRaw = inventory.items();
  const carried = carriedRaw.map(snapshotItem).filter(isPresent);
  const totals = rollupTotals(carried);
  const slots = inventory.slots;
  const start = inventory.inventoryStart ?? 9;
  const end = inventory.inventoryEnd ?? 45;
  const capacity = Math.max(0, end - start) || 36;
  const usedSlots = Array.isArray(slots)
    ? slots.slice(start, end).filter(Boolean).length
    : carriedRaw.length;
  const hotbar = Array.isArray(slots)
    ? slots.slice(36, 45).map(snapshotItem).filter(isPresent)
    : carried;
  const equipment = {
    head: equipmentItem(bot, "head", slots),
    torso: equipmentItem(bot, "torso", slots),
    legs: equipmentItem(bot, "legs", slots),
    feet: equipmentItem(bot, "feet", slots),
    offHand: equipmentItem(bot, "off-hand", slots),
  };
  const held = snapshotItem((bot as Bot & { heldItem?: ItemLike | null }).heldItem);
  const durabilityCandidates = [
    ...carried,
    equipment.head,
    equipment.torso,
    equipment.legs,
    equipment.feet,
    equipment.offHand,
  ].filter(isPresent);
  const nearBreaking = durabilityCandidates.filter((item) =>
    item.durability !== null && item.durability.percent <= 10);

  return {
    available: true,
    carried,
    totals,
    hotbar,
    held,
    equipment,
    capacity,
    usedSlots,
    freeSlots: Math.max(0, capacity - usedSlots),
    nearBreaking,
  };
}

export function checkInventoryRequirements(
  snapshot: InventorySnapshot,
  requirements: InventoryRequirement[],
): InventoryRequirementStatus[] {
  const totals = new Map(
    snapshot.totals.map((entry) => [entry.name.toLowerCase(), entry.count]),
  );
  return requirements.map((requirement) => {
    const item = requirement.item.trim().toLowerCase();
    const have = totals.get(item) ?? 0;
    const missing = Math.max(0, requirement.quantity - have);
    return {
      item,
      quantity: requirement.quantity,
      have,
      missing,
      satisfied: missing === 0,
    };
  });
}

/**
 * Estimate how many additional items of one type fit in carried inventory.
 * Existing partial stacks count before empty inventory slots.
 */
export function estimateInventorySpace(bot: Bot, itemName: string): number {
  const inventory = (bot as Bot & {
    inventory?: {
      items?: () => Array<ItemLike & { stackSize?: number | null }>;
    };
  }).inventory;
  if (!inventory?.items) return 0;
  const normalized = itemName.trim().toLowerCase();
  const carried = inventory.items();
  const registryStackSize =
    (bot.registry?.itemsByName?.[normalized] as { stackSize?: number } | undefined)
      ?.stackSize;
  const matching = carried.filter((item) => item.name?.toLowerCase() === normalized);
  const observedStackSize = matching.find((item) =>
    typeof item.stackSize === "number")?.stackSize;
  const stackSize = Math.max(1, registryStackSize ?? observedStackSize ?? 64);
  const partialSpace = matching.reduce(
    (total, item) => total + Math.max(0, stackSize - (item.count ?? 1)),
    0,
  );
  return partialSpace + createInventorySnapshot(bot).freeSlots * stackSize;
}

export function formatInventoryContext(snapshot: InventorySnapshot): string {
  if (!snapshot.available) return "inventory unavailable until spawn";
  const samples = snapshot.totals
    .slice(0, 5)
    .map((entry) => `${entry.count} ${entry.name}`)
    .join(", ");
  const equipment = formatEquipment(snapshot);
  const held = snapshot.held ? formatItem(snapshot.held) : "empty hand";
  const warnings = snapshot.nearBreaking.length > 0
    ? ` | low durability ${snapshot.nearBreaking.map(formatItem).join(", ")}`
    : "";
  return (
    `inventory ${snapshot.usedSlots}/${snapshot.capacity} slots ` +
    `(${snapshot.freeSlots} free)` +
    `${samples ? ` | carried ${samples}` : " | carried empty"}` +
    ` | held ${held} | ${equipment}${warnings}`
  );
}

export function formatEquipment(snapshot: InventorySnapshot): string {
  const entries: Array<[string, InventoryItemSnapshot | null]> = [
    ["head", snapshot.equipment.head],
    ["torso", snapshot.equipment.torso],
    ["legs", snapshot.equipment.legs],
    ["feet", snapshot.equipment.feet],
    ["offhand", snapshot.equipment.offHand],
  ];
  const present = entries
    .filter((entry): entry is [string, InventoryItemSnapshot] => entry[1] !== null)
    .map(([slot, item]) => `${slot}:${formatItem(item)}`);
  return present.length > 0 ? `equipment ${present.join(", ")}` : "equipment empty";
}

export function formatItem(item: InventoryItemSnapshot): string {
  const name = item.customName || item.name;
  const durability = item.durability
    ? ` ${item.durability.remaining}/${item.durability.maximum} durability`
    : "";
  const enchantments = item.enchantments.length > 0
    ? ` [${item.enchantments.map((entry) => `${entry.name} ${entry.level}`).join(", ")}]`
    : "";
  return `${item.count} ${name}${durability}${enchantments}`;
}

function equipmentItem(
  bot: Bot,
  destination: Exclude<EquipmentDestination, "hand">,
  slots: Array<ItemLike | null | undefined> | undefined,
): InventoryItemSnapshot | null {
  if (!Array.isArray(slots)) return null;
  let slot = FALLBACK_EQUIPMENT_SLOTS[destination];
  try {
    const resolved = bot.getEquipmentDestSlot(destination);
    if (typeof resolved === "number") slot = resolved;
  } catch {
    // Older/fake clients may not support off-hand; use the vanilla fallback.
  }
  return snapshotItem(slots[slot]);
}

function snapshotItem(item: ItemLike | null | undefined): InventoryItemSnapshot | null {
  if (!item?.name) return null;
  const maximum = typeof item.maxDurability === "number" ? item.maxDurability : 0;
  const used = typeof item.durabilityUsed === "number" ? item.durabilityUsed : 0;
  const remaining = Math.max(0, maximum - used);
  let enchants: Array<{ name?: string | null; lvl?: number | null }> = [];
  try {
    enchants = Array.isArray(item.enchants) ? item.enchants : [];
  } catch {
    // Malformed custom NBT should not hide the rest of the inventory.
  }
  return {
    name: item.name,
    count: typeof item.count === "number" ? item.count : 1,
    slot: typeof item.slot === "number" ? item.slot : null,
    customName: item.customName ?? null,
    durability: maximum > 0
      ? {
          remaining,
          maximum,
          percent: Math.round((remaining / maximum) * 100),
        }
      : null,
    enchantments: enchants
      .filter((entry) => Boolean(entry.name))
      .map((entry) => ({
        name: entry.name!,
        level: typeof entry.lvl === "number" ? entry.lvl : 1,
      })),
  };
}

function rollupTotals(
  items: InventoryItemSnapshot[],
): Array<{ name: string; count: number }> {
  const totals = new Map<string, number>();
  for (const item of items) {
    totals.set(item.name, (totals.get(item.name) ?? 0) + item.count);
  }
  return [...totals.entries()]
    .map(([name, count]) => ({ name, count }))
    .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name));
}

function isPresent<T>(value: T | null | undefined): value is T {
  return value !== null && value !== undefined;
}

function emptySnapshot(): InventorySnapshot {
  return {
    available: false,
    carried: [],
    totals: [],
    hotbar: [],
    held: null,
    equipment: {
      head: null,
      torso: null,
      legs: null,
      feet: null,
      offHand: null,
    },
    capacity: 0,
    usedSlots: 0,
    freeSlots: 0,
    nearBreaking: [],
  };
}
