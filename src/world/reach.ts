// Portions adapted from yuniko-software/minecraft-mcp-server,
// src/tools/block-tools.ts @ 240c8cec337ce152cc9e058ebdef511055808406.
// Licensed under Apache-2.0; see LICENSES/yuniko-minecraft-mcp-Apache-2.0.txt.
// Modified by SmartBotMC: bounded, cancellation-aware reference selection and
// post-pathfinding world refresh rather than direct raw Mineflayer goto calls.

import { Vec3 } from "vec3";
import { goals, pathfindTo } from "../skills/pathfinder.js";
import {
  isAirSnapshot,
  snapshotBlock,
  type BlockSnapshot,
} from "./blockSnapshot.js";
import type { BlockPosition } from "./types.js";

export type PlacementFace = "up" | "down" | "north" | "south" | "east" | "west";

export interface PlacementReference {
  readonly position: BlockPosition;
  /** Face on the reference block that Mineflayer receives. */
  readonly face: PlacementFace;
  readonly faceVector: BlockPosition;
  readonly snapshot: BlockSnapshot;
}

/**
 * A bounded choice among the six ordinary Mineflayer placement faces.
 *
 * `requiredFaces` is a hard restriction: a stateful adapter can require a
 * side click when Minecraft derives a property from click height. `preferredFaces`
 * only changes deterministic ordering within the viable candidates, preserving
 * the ordinary canonical order as a fallback.
 */
export interface PlacementReferenceSelection {
  readonly requiredFaces?: readonly PlacementFace[];
  readonly preferredFaces?: readonly PlacementFace[];
}

export interface PlacementReachSuccess {
  ok: true;
  target: BlockPosition;
  reference: PlacementReference;
  pathfound: boolean;
}

export interface PlacementReachFailure {
  ok: false;
  code: "NO_PATH" | "WORLD_UNAVAILABLE" | "TARGET_UNAVAILABLE" | "INTERRUPTED";
  summary: string;
  recoverable: boolean;
  details?: Record<string, unknown>;
}

export type PlacementReachResult = PlacementReachSuccess | PlacementReachFailure;

/** A live Mineflayer block used only to perform the immediately following action. */
export interface ReachableBlock {
  readonly name: string;
  readonly position: Vec3;
  readonly boundingBox?: string;
  readonly stateId?: number;
  readonly diggable?: boolean;
  readonly getProperties?: () => Record<string, unknown>;
}

/** Successful generic interaction reach check, suitable for digging or activation. */
export interface BlockReachSuccess {
  ok: true;
  target: BlockPosition;
  block: ReachableBlock;
  pathfound: boolean;
}

export type BlockReachFailure = PlacementReachFailure;
export type BlockReachResult = BlockReachSuccess | BlockReachFailure;

interface FaceCandidate {
  referenceOffset: BlockPosition;
  face: PlacementFace;
  faceVector: BlockPosition;
}

/** SmartBot's deterministic construction ordering: support below first. */
export const PLACEMENT_FACES: readonly FaceCandidate[] = Object.freeze([
  { referenceOffset: { x: 0, y: -1, z: 0 }, face: "up", faceVector: { x: 0, y: 1, z: 0 } },
  { referenceOffset: { x: 1, y: 0, z: 0 }, face: "west", faceVector: { x: -1, y: 0, z: 0 } },
  { referenceOffset: { x: -1, y: 0, z: 0 }, face: "east", faceVector: { x: 1, y: 0, z: 0 } },
  { referenceOffset: { x: 0, y: 0, z: 1 }, face: "north", faceVector: { x: 0, y: 0, z: -1 } },
  { referenceOffset: { x: 0, y: 0, z: -1 }, face: "south", faceVector: { x: 0, y: 0, z: 1 } },
  { referenceOffset: { x: 0, y: 1, z: 0 }, face: "down", faceVector: { x: 0, y: -1, z: 0 } },
]);

/** Side clicks are the only ordinary placement path that can select a half. */
export const HORIZONTAL_PLACEMENT_FACES: readonly PlacementFace[] = Object.freeze([
  "west",
  "east",
  "north",
  "south",
]);

type ReachBot = {
  entity?: { position?: Vec3 };
  blockAt(position: Vec3): ReachableBlock | null | undefined;
  // The actual Mineflayer Block type is intentionally not imported here;
  // `never` accepts its narrower method parameter structurally.
  canSeeBlock?: (block: never) => boolean;
};

/** Normalize user/world coordinates once at the public reach boundary. */
export function floorBlockPosition(position: BlockPosition): BlockPosition {
  if (![position.x, position.y, position.z].every(Number.isFinite)) {
    throw new Error("block coordinates must be finite");
  }
  return Object.freeze({
    x: Math.floor(position.x),
    y: Math.floor(position.y),
    z: Math.floor(position.z),
  });
}

export function isAtBotBody(bot: ReachBot, target: BlockPosition): boolean {
  const position = bot.entity?.position;
  if (!position) return false;
  const feet = floorBlockPosition(position);
  return target.x === feet.x && target.z === feet.z &&
    (target.y === feet.y || target.y === feet.y + 1);
}

/** Find the first solid support block using the canonical face ordering. */
export function findPlacementReference(
  bot: ReachBot,
  rawTarget: BlockPosition,
  selection?: PlacementReferenceSelection,
): PlacementReference | undefined {
  return inspectPlacementReference(bot, floorBlockPosition(rawTarget), selection).reference;
}

function inspectPlacementReference(
  bot: ReachBot,
  target: BlockPosition,
  selection?: PlacementReferenceSelection,
): { reference: PlacementReference | undefined; unavailable: boolean } {
  let unavailable = false;
  for (const candidate of orderedFaceCandidates(selection)) {
    const position = {
      x: target.x + candidate.referenceOffset.x,
      y: target.y + candidate.referenceOffset.y,
      z: target.z + candidate.referenceOffset.z,
    };
    const block = bot.blockAt(new Vec3(position.x, position.y, position.z));
    if (!block) {
      unavailable = true;
      continue;
    }
    const snapshot = snapshotBlock(block, position);
    if (isAirSnapshot(snapshot) || snapshot.boundingBox === "empty") continue;
    return {
      reference: Object.freeze({
        position: Object.freeze(position),
        face: candidate.face,
        faceVector: Object.freeze({ ...candidate.faceVector }),
        snapshot,
      }),
      unavailable,
    };
  }
  return { reference: undefined, unavailable };
}

/**
 * Ensure a safe reference is interactable. Calls the existing bounded
 * pathfinder only when visibility/range requires it, then rereads the world.
 */
export async function ensurePlacementReach(
  bot: ReachBot,
  rawTarget: BlockPosition,
  options: { signal: AbortSignal; reach?: number; selection?: PlacementReferenceSelection },
): Promise<PlacementReachResult> {
  const target = floorBlockPosition(rawTarget);
  const reach = options.reach ?? 4.5;
  if (options.signal.aborted) return interrupted(target);
  if (isAtBotBody(bot, target)) {
    return fail("TARGET_UNAVAILABLE", `refusing placement at bot body ${formatPosition(target)}`, false);
  }
  const targetBlock = bot.blockAt(new Vec3(target.x, target.y, target.z));
  if (!targetBlock) {
    return fail("WORLD_UNAVAILABLE", `world data unavailable at ${formatPosition(target)}`, true);
  }
  let referenceInspection = inspectPlacementReference(bot, target, options.selection);
  let reference = referenceInspection.reference;
  if (!reference) {
    if (referenceInspection.unavailable) {
      return fail("WORLD_UNAVAILABLE", `world data unavailable near ${formatPosition(target)}`, true);
    }
    return fail("TARGET_UNAVAILABLE", `no solid placement reference near ${formatPosition(target)}`, true);
  }
  const needsPath = distance(bot.entity?.position, target) > reach ||
    (bot.canSeeBlock ? !bot.canSeeBlock(bot.blockAt(new Vec3(
      reference.position.x, reference.position.y, reference.position.z,
    ))! as never) : false);
  let pathfound = false;
  if (needsPath) {
    if (options.signal.aborted) return interrupted(target);
    try {
      await pathfindTo(bot as never, new goals.GoalNear(target.x, target.y, target.z, reach), options.signal);
      pathfound = true;
    } catch (error) {
      if (options.signal.aborted || errorMessage(error) === "aborted") return interrupted(target);
      return fail("NO_PATH", `could not reach placement at ${formatPosition(target)}: ${errorMessage(error)}`, true);
    }
    if (options.signal.aborted) return interrupted(target);
    const refreshedTarget = bot.blockAt(new Vec3(target.x, target.y, target.z));
    if (!refreshedTarget) {
      return fail("WORLD_UNAVAILABLE", `world data unavailable after pathfinding at ${formatPosition(target)}`, true);
    }
    referenceInspection = inspectPlacementReference(bot, target, options.selection);
    reference = referenceInspection.reference;
    if (!reference) {
      if (referenceInspection.unavailable) {
        return fail("WORLD_UNAVAILABLE", `world data unavailable near ${formatPosition(target)}`, true);
      }
      return fail("TARGET_UNAVAILABLE", `placement reference changed near ${formatPosition(target)}`, true);
    }
  }
  return { ok: true, target, reference, pathfound };
}

/**
 * Ensure that a concrete target block is visible and in interaction range.
 * The returned block is always reread after routing, so callers never act on
 * a stale pre-pathfinding Mineflayer Block object.
 */
export function ensureReachableBlock(
  bot: ReachBot,
  rawTarget: BlockPosition,
  signal: AbortSignal,
): Promise<BlockReachResult>;
export function ensureReachableBlock(
  bot: ReachBot,
  rawTarget: BlockPosition,
  options: { signal: AbortSignal; reach?: number },
): Promise<BlockReachResult>;
export async function ensureReachableBlock(
  bot: ReachBot,
  rawTarget: BlockPosition,
  optionsOrSignal: AbortSignal | { signal: AbortSignal; reach?: number },
): Promise<BlockReachResult> {
  const options = "signal" in optionsOrSignal
    ? optionsOrSignal
    : { signal: optionsOrSignal };
  const target = floorBlockPosition(rawTarget);
  const reach = options.reach ?? 4.5;
  if (options.signal.aborted) return interrupted(target, "block");

  let block = bot.blockAt(new Vec3(target.x, target.y, target.z));
  if (!block) {
    return fail("WORLD_UNAVAILABLE", `world data unavailable at ${formatPosition(target)}`, true);
  }

  let pathfound = false;
  const needsPath = distance(bot.entity?.position, target) > reach ||
    (bot.canSeeBlock ? !bot.canSeeBlock(block as never) : false);
  if (needsPath) {
    if (options.signal.aborted) return interrupted(target, "block");
    try {
      await pathfindTo(bot as never, new goals.GoalNear(target.x, target.y, target.z, reach), options.signal);
      pathfound = true;
    } catch (error) {
      if (options.signal.aborted || errorMessage(error) === "aborted") return interrupted(target, "block");
      return fail("NO_PATH", `could not reach block at ${formatPosition(target)}: ${errorMessage(error)}`, true);
    }
    if (options.signal.aborted) return interrupted(target, "block");
    block = bot.blockAt(new Vec3(target.x, target.y, target.z));
    if (!block) {
      return fail("WORLD_UNAVAILABLE", `world data unavailable after pathfinding at ${formatPosition(target)}`, true);
    }
  }

  return { ok: true, target, block, pathfound };
}

/** Compatibility name used by the executor; keeps options out of its public API. */
export function ensureReachableReference(
  bot: ReachBot,
  target: BlockPosition,
  signal: AbortSignal,
  selection?: PlacementReferenceSelection,
): Promise<PlacementReachResult> {
  return ensurePlacementReach(bot, target, { signal, selection });
}

function orderedFaceCandidates(
  selection: PlacementReferenceSelection | undefined,
): readonly FaceCandidate[] {
  const required = selection?.requiredFaces === undefined
    ? undefined
    : new Set(selection.requiredFaces);
  const preferredOrder = new Map<PlacementFace, number>();
  for (const [index, face] of (selection?.preferredFaces ?? []).entries()) {
    if (!preferredOrder.has(face)) preferredOrder.set(face, index);
  }
  return PLACEMENT_FACES
    .filter((candidate) => required === undefined || required.has(candidate.face))
    .slice()
    .sort((left, right) => {
      const leftPreference = preferredOrder.get(left.face) ?? Number.POSITIVE_INFINITY;
      const rightPreference = preferredOrder.get(right.face) ?? Number.POSITIVE_INFINITY;
      if (leftPreference !== rightPreference) return leftPreference - rightPreference;
      return PLACEMENT_FACES.indexOf(left) - PLACEMENT_FACES.indexOf(right);
    });
}

function fail(
  code: PlacementReachFailure["code"],
  summary: string,
  recoverable: boolean,
): PlacementReachFailure {
  return { ok: false, code, summary, recoverable };
}

function interrupted(target: BlockPosition, subject = "placement"): PlacementReachFailure {
  return fail("INTERRUPTED", `${subject} reach interrupted at ${formatPosition(target)}`, true);
}

function distance(position: Vec3 | undefined, target: BlockPosition): number {
  if (!position) return Number.POSITIVE_INFINITY;
  const dx = position.x - target.x;
  const dy = position.y - target.y;
  const dz = position.z - target.z;
  return Math.sqrt(dx * dx + dy * dy + dz * dz);
}

function formatPosition(position: BlockPosition): string {
  return `${position.x},${position.y},${position.z}`;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
