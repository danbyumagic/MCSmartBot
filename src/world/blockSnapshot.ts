import type { BlockPosition } from "./types.js";

export type BlockPropertyValue = string | number | boolean;

/**
 * Immutable, bounded data which is safe to compare, persist, and expose over
 * IPC. This deliberately does not retain a Prismarine Block instance.
 */
export interface BlockSnapshot {
  readonly position: BlockPosition;
  readonly name: string;
  readonly stateId?: number;
  readonly properties: Readonly<Record<string, BlockPropertyValue>>;
  readonly boundingBox: "block" | "empty" | "unknown";
  readonly replaceable: boolean;
  readonly diggable: boolean;
  readonly key: string;
}

export const AIR_BLOCK_NAMES = new Set(["air", "cave_air", "void_air"]);
export const REPLACEABLE_BLOCK_NAMES = new Set([
  ...AIR_BLOCK_NAMES,
  "short_grass",
  "tall_grass",
  "fern",
  "large_fern",
  "dead_bush",
  "snow",
  "vine",
  "glow_lichen",
  "seagrass",
  "tall_seagrass",
]);

type BlockLike = {
  name?: unknown;
  stateId?: unknown;
  position?: { x?: unknown; y?: unknown; z?: unknown };
  boundingBox?: unknown;
  diggable?: unknown;
  getProperties?: () => unknown;
};

/** Capture a block as stable primitive data, floor coordinates exactly once. */
export function snapshotBlock(
  block: BlockLike,
  positionOverride?: BlockPosition,
): BlockSnapshot {
  const position = normalizePosition(positionOverride ?? block.position);
  const name = typeof block.name === "string" && block.name.length > 0
    ? block.name
    : "unknown";
  const stateId = typeof block.stateId === "number" && Number.isSafeInteger(block.stateId)
    ? block.stateId
    : undefined;
  const properties = snapshotProperties(block);
  const boundingBox = block.boundingBox === "block" || block.boundingBox === "empty"
    ? block.boundingBox
    : "unknown";
  const replaceable = REPLACEABLE_BLOCK_NAMES.has(name);
  const diggable = block.diggable !== false;
  const key = [
    `${position.x},${position.y},${position.z}`,
    name,
    `state:${stateId ?? "none"}`,
    `box:${boundingBox}`,
    `replaceable:${replaceable}`,
    `diggable:${diggable}`,
    Object.entries(properties)
      .map(([key, value]) => `${encode(key)}=${encodeValue(value)}`)
      .join("&"),
  ].join("|");
  return Object.freeze({
    position: Object.freeze(position),
    name,
    stateId,
    properties: Object.freeze(properties),
    boundingBox,
    replaceable,
    diggable,
    key,
  });
}

export function sameBlockSnapshot(
  first: BlockSnapshot,
  second: BlockSnapshot,
): boolean {
  if (
    first.name !== second.name ||
    first.stateId !== second.stateId ||
    first.boundingBox !== second.boundingBox ||
    first.diggable !== second.diggable ||
    first.replaceable !== second.replaceable ||
    first.position.x !== second.position.x ||
    first.position.y !== second.position.y ||
    first.position.z !== second.position.z
  ) return false;
  const firstEntries = Object.entries(first.properties);
  const secondEntries = Object.entries(second.properties);
  return firstEntries.length === secondEntries.length && firstEntries.every(([key, value]) =>
    second.properties[key] === value,
  );
}

export function isAirSnapshot(snapshot: BlockSnapshot): boolean {
  return AIR_BLOCK_NAMES.has(snapshot.name);
}

function normalizePosition(value: unknown): BlockPosition {
  if (typeof value !== "object" || value === null) {
    throw new Error("block snapshot requires a finite position");
  }
  const candidate = value as { x?: unknown; y?: unknown; z?: unknown };
  const values = [candidate.x, candidate.y, candidate.z];
  if (values.some((coordinate) => typeof coordinate !== "number" || !Number.isFinite(coordinate))) {
    throw new Error("block snapshot requires finite coordinates");
  }
  return {
    x: Math.floor(candidate.x as number),
    y: Math.floor(candidate.y as number),
    z: Math.floor(candidate.z as number),
  };
}

function snapshotProperties(block: BlockLike): Record<string, BlockPropertyValue> {
  let source: unknown;
  try {
    source = block.getProperties?.();
  } catch {
    source = undefined;
  }
  if (typeof source !== "object" || source === null || Array.isArray(source)) return {};
  const properties: Record<string, BlockPropertyValue> = {};
  for (const key of Object.keys(source).sort().slice(0, 32)) {
    const value = (source as Record<string, unknown>)[key];
    if (typeof value === "string") {
      properties[key] = value.slice(0, 128);
    } else if (typeof value === "boolean") {
      properties[key] = value;
    } else if (typeof value === "number" && Number.isFinite(value)) {
      properties[key] = value;
    }
  }
  return properties;
}

function encode(value: string): string {
  return encodeURIComponent(value);
}

function encodeValue(value: BlockPropertyValue): string {
  if (typeof value === "string") return `s:${encode(value)}`;
  if (typeof value === "number") return `n:${value}`;
  return `b:${value}`;
}
