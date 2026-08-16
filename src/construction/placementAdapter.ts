import type { Cardinal, PlacementHint } from "./buildOps/types.js";
import {
  placeAt,
  type BlockExpectation,
  type BlockMutationHooks,
} from "../world/blockExecutor.js";
import {
  HORIZONTAL_PLACEMENT_FACES,
  type PlacementFace,
  type PlacementReferenceSelection,
} from "../world/reach.js";
import type { BlockSnapshot } from "../world/blockSnapshot.js";
import type {
  BlockMutationResult,
  BlockPosition,
  BlockStatePredicate,
} from "../world/types.js";

/**
 * One ordinary survival placement plus the only v1 state hints this adapter
 * understands. It intentionally does not describe doors or any multi-cell
 * item: one invocation means exactly one expected world cell.
 */
export interface BuildPlacementAdapterInput {
  readonly position: BlockPosition;
  readonly item: string;
  readonly signal: AbortSignal;
  readonly hint?: PlacementHint;
  readonly expected?: BlockExpectation;
  readonly expectedAfter?: BlockStatePredicate;
  readonly allowReplace?: boolean;
  readonly hooks?: BlockMutationHooks;
}

/** The normal executor bot plus the live block-state registry used for gating. */
export type BuildPlacementAdapterBot = Parameters<typeof placeAt>[0] & RegistryStateBot;

interface RegistryStateBot {
  readonly registry?: {
    readonly blocksByName?: Readonly<Record<string, { readonly states?: unknown }>>;
  };
}

interface NormalizedHint {
  readonly facing?: Cardinal;
  readonly half?: "top" | "bottom";
}

interface StatefulPlan {
  readonly yaw: number;
  readonly half?: "top" | "bottom";
  readonly selection: PlacementReferenceSelection;
}

type HintPlanResult =
  | { readonly ok: true; readonly hint: NormalizedHint; readonly plan: StatefulPlan }
  | { readonly ok: false; readonly result: BlockMutationResult };

const CARDINALS = new Set<Cardinal>(["north", "south", "east", "west"]);
const HALVES = new Set<NormalizedHint["half"]>(["top", "bottom"]);
const ONE_CELL_STAIRS = /^[a-z0-9_]+_stairs$/;

/**
 * Place one Blueprint placement unit through the shared verified executor.
 *
 * Unhinted calls deliberately take the unchanged public `placeBlock` path.
 * Hinted calls are narrow: only a live-registry-verified one-cell stair gets a
 * controlled ordinary Mineflayer click, then its observable properties must
 * match before the placement is reported as successful or journaled applied.
 */
export async function placeBuildPlacement(
  bot: BuildPlacementAdapterBot,
  input: BuildPlacementAdapterInput,
): Promise<BlockMutationResult> {
  if (input.hint === undefined) {
    return placeAt(bot, {
      position: input.position,
      item: input.item,
      signal: input.signal,
      expected: input.expected,
      expectedAfter: input.expectedAfter,
      allowReplace: input.allowReplace,
      hooks: input.hooks,
    });
  }

  const planned = planHintedPlacement(bot, input.item, input.hint);
  if (!planned.ok) return planned.result;
  return placeAt(bot, {
    position: input.position,
    item: input.item,
    signal: input.signal,
    expected: input.expected,
    expectedAfter: (after) =>
      matchesHint(after, planned.hint) && (input.expectedAfter?.(after) ?? true),
    intendedProperties: hintedProperties(planned.hint),
    stateful: planned.plan,
    allowReplace: input.allowReplace,
    hooks: input.hooks,
  });
}

/** Mineflayer yaw is right-handed from north (-Z), matching live player facing. */
export function yawForPlacementFacing(facing: Cardinal): number {
  switch (facing) {
    case "north": return 0;
    case "east": return -Math.PI / 2;
    case "south": return Math.PI;
    case "west": return Math.PI / 2;
  }
}

function planHintedPlacement(
  bot: BuildPlacementAdapterBot,
  item: string,
  rawHint: PlacementHint,
): HintPlanResult {
  const normalized = normalizeHint(rawHint, item);
  if (!normalized.ok) return normalized;
  const hint = normalized.hint;

  // This deliberately excludes doors, beds, tall plants, and any future
  // item whose one click can create more than the single expected cell.
  if (!ONE_CELL_STAIRS.test(item)) {
    return unsupported(
      `stateful placement for '${item}' is unavailable: only one-cell *_stairs hints are verified`,
      { item, reason: "multi-cell and non-stair stateful placement is disabled" },
    );
  }
  if (typeof (bot as { look?: unknown }).look !== "function" ||
      typeof (bot as { _placeBlockWithOptions?: unknown })._placeBlockWithOptions !== "function") {
    return unsupported(
      "this Mineflayer runtime cannot perform the ordinary stateful placement helper required for hints",
      { item },
    );
  }
  const states = bot.registry?.blocksByName?.[item]?.states;
  if (!Array.isArray(states)) {
    return unsupported(
      `live registry state metadata for '${item}' is unavailable; refusing hinted placement`,
      { item },
    );
  }
  if (hint.facing && !registryAllows(states, "facing", hint.facing)) {
    return unsupported(
      `live registry cannot verify facing='${hint.facing}' for '${item}'`,
      { item, property: "facing", value: hint.facing },
    );
  }
  if (hint.half && !registryAllows(states, "half", hint.half)) {
    return unsupported(
      `live registry cannot verify half='${hint.half}' for '${item}'`,
      { item, property: "half", value: hint.half },
    );
  }

  return {
    ok: true,
    hint,
    plan: Object.freeze({
      // Even a half-only request gets a controlled yaw. This prevents the
      // native helper from awaiting an implicit look after journal planning.
      yaw: yawForPlacementFacing(hint.facing ?? "north"),
      ...(hint.half === undefined ? {} : { half: hint.half }),
      selection: selectionForHint(hint),
    }),
  };
}

function normalizeHint(raw: PlacementHint, item: string):
  | { readonly ok: true; readonly hint: NormalizedHint }
  | { readonly ok: false; readonly result: BlockMutationResult } {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    return unsupported("stateful placement hint must be an object", { item });
  }
  const candidate = raw as { facing?: unknown; half?: unknown };
  const keys = Object.keys(candidate);
  if (keys.length === 0 || keys.some((key) => key !== "facing" && key !== "half")) {
    return unsupported("stateful placement hint contains unsupported properties", { item, keys });
  }
  if (candidate.facing !== undefined &&
      (typeof candidate.facing !== "string" || !CARDINALS.has(candidate.facing as Cardinal))) {
    return unsupported("stateful placement hint requires a cardinal facing", { item, facing: candidate.facing });
  }
  if (candidate.half !== undefined &&
      (typeof candidate.half !== "string" || !HALVES.has(candidate.half as NormalizedHint["half"]))) {
    return unsupported("stateful placement hint requires half 'top' or 'bottom'", { item, half: candidate.half });
  }
  return {
    ok: true,
    hint: Object.freeze({
      ...(candidate.facing === undefined ? {} : { facing: candidate.facing as Cardinal }),
      ...(candidate.half === undefined ? {} : { half: candidate.half as "top" | "bottom" }),
    }),
  };
}

function selectionForHint(hint: NormalizedHint): PlacementReferenceSelection {
  const preferredFaces = distinctFaces([
    ...(hint.facing === undefined ? [] : [hint.facing]),
    ...HORIZONTAL_PLACEMENT_FACES,
  ]);
  return Object.freeze({
    // Mineflayer's half option controls click height only on a side face.
    ...(hint.half === undefined ? {} : { requiredFaces: HORIZONTAL_PLACEMENT_FACES }),
    preferredFaces: Object.freeze(preferredFaces),
  });
}

function distinctFaces(values: readonly PlacementFace[]): PlacementFace[] {
  return [...new Set(values)];
}

function registryAllows(states: readonly unknown[], name: string, value: string): boolean {
  return states.some((state) => {
    if (typeof state !== "object" || state === null || Array.isArray(state)) return false;
    const candidate = state as { name?: unknown; values?: unknown };
    return candidate.name === name && Array.isArray(candidate.values) && candidate.values.includes(value);
  });
}

function hintedProperties(hint: NormalizedHint): Readonly<Record<string, string>> {
  return Object.freeze({
    ...(hint.facing === undefined ? {} : { facing: hint.facing }),
    ...(hint.half === undefined ? {} : { half: hint.half }),
  });
}

function matchesHint(snapshot: BlockSnapshot, hint: NormalizedHint): boolean {
  return (hint.facing === undefined || snapshot.properties.facing === hint.facing) &&
    (hint.half === undefined || snapshot.properties.half === hint.half);
}

function unsupported(summary: string, details: Record<string, unknown>): HintPlanResult {
  return {
    ok: false,
    result: {
      ok: false,
      code: "UNSUPPORTED_STATE",
      summary,
      recoverable: false,
      details,
    },
  };
}
