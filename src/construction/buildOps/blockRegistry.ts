import type {
  BuildBlockRegistry,
  BuildCompileError,
  NormalizedBlock,
} from "./types.js";

/** Blocks that a normal client-side inventory placement adapter must not promise to build. */
export const UNSUPPORTED_BUILD_BLOCKS = new Set([
  "air",
  "cave_air",
  "void_air",
  "bedrock",
  "barrier",
  "command_block",
  "chain_command_block",
  "repeating_command_block",
  "structure_block",
  "jigsaw",
  "light",
  "end_portal",
  "end_portal_frame",
  "nether_portal",
  "water",
  "lava",
  "fire",
  "soul_fire",
  "moving_piston",
  "piston_head",
  "bubble_column",
]);

/** Valid inventory materials whose use requires the owner capability boundary. */
export const HAZARDOUS_BUILD_BLOCKS = new Set([
  "tnt",
]);

export interface BlockNormalizationSuccess {
  readonly ok: true;
  readonly value: NormalizedBlock;
}

export interface BlockNormalizationFailure {
  readonly ok: false;
  readonly error: BuildCompileError;
}

export type BlockNormalizationResult = BlockNormalizationSuccess | BlockNormalizationFailure;

/**
 * Normalize a minecraft-data or live-bot registry to the deliberately tiny
 * BuildOps dependency surface. The source registry is never interpreted as a
 * protocol handle and is not retained by compiled results.
 */
export function createBuildBlockRegistry(source: unknown, version?: string): BuildBlockRegistry {
  if (typeof source !== "object" || source === null) {
    throw new Error("BuildOps registry must be an object");
  }
  const candidate = source as {
    version?: unknown;
    minecraftVersion?: unknown;
    blocksByName?: unknown;
    itemsByName?: unknown;
  };
  const resolvedVersion = version ?? readVersion(candidate.version) ?? readVersion(candidate.minecraftVersion);
  if (!resolvedVersion) throw new Error("BuildOps registry must provide a Minecraft version");
  if (!isRecord(candidate.blocksByName) || !isRecord(candidate.itemsByName)) {
    throw new Error("BuildOps registry must provide blocksByName and itemsByName maps");
  }
  return Object.freeze({
    version: resolvedVersion,
    blocksByName: candidate.blocksByName,
    itemsByName: candidate.itemsByName,
  });
}

/** Treat a normal block as placeable only when both block and matching item exist. */
export function normalizeBuildBlock(raw: unknown, registry: BuildBlockRegistry): BlockNormalizationResult {
  const requested = canonicalRawBlockName(raw);
  if (!requested) {
    return failure("BLOCK_UNKNOWN", "block must be a plain Minecraft block identifier", { raw });
  }
  if (UNSUPPORTED_BUILD_BLOCKS.has(requested)) {
    return failure("BLOCK_UNSUPPORTED", `block '${requested}' is server-managed or unsupported for normal placement`, {
      block: requested,
    });
  }

  const exact = isPlaceableBlock(requested, registry);
  if (exact) return success(requested);

  const candidates = aliasCandidates(requested)
    .filter((candidate) => isPlaceableBlock(candidate, registry));
  if (candidates.length === 1) {
    const repaired = candidates[0]!;
    return {
      ok: true,
      value: {
        block: repaired,
        item: repaired,
        risk: classifyBuildBlock(repaired),
        warning: {
          code: "BLOCK_NORMALIZED",
          message: `normalized block '${requested}' to '${repaired}'`,
          from: requested,
          to: repaired,
        },
      },
    };
  }
  if (candidates.length > 1) {
    return failure("BLOCK_AMBIGUOUS", `block '${requested}' has multiple possible safe aliases`, {
      block: requested,
      candidates: candidates.sort(),
    });
  }

  if (hasOwn(registry.blocksByName, requested)) {
    return failure("BLOCK_NOT_PLACEABLE", `block '${requested}' has no corresponding placeable item`, {
      block: requested,
      version: registry.version,
    });
  }
  return failure("BLOCK_UNKNOWN", `unknown block '${requested}' for Minecraft ${registry.version}`, {
    block: requested,
    version: registry.version,
  });
}

/** Stable public classifier used by compilation and later authorization integration. */
export function classifyBuildBlock(block: string): "normal" | "hazardous" {
  return HAZARDOUS_BUILD_BLOCKS.has(block) ? "hazardous" : "normal";
}

/** Remove one Minecraft namespace prefix and reject states/other unsafe syntax. */
export function canonicalRawBlockName(raw: unknown): string | undefined {
  if (typeof raw !== "string") return undefined;
  let value = raw.trim().toLowerCase();
  if (value.startsWith("minecraft:")) value = value.slice("minecraft:".length);
  if (!/^[a-z0-9_]+$/.test(value)) return undefined;
  return value;
}

function success(block: string): BlockNormalizationSuccess {
  return {
    ok: true,
    value: {
      block,
      item: block,
      risk: classifyBuildBlock(block),
    },
  };
}

function failure(
  code: BuildCompileError["code"],
  message: string,
  details: Record<string, unknown>,
): BlockNormalizationFailure {
  return { ok: false, error: { code, message, details } };
}

function aliasCandidates(requested: string): string[] {
  const candidates = new Set<string>();
  if (requested.endsWith("s") && requested.length > 1) candidates.add(requested.slice(0, -1));
  candidates.add(`${requested}s`);
  return [...candidates].filter((candidate) => candidate !== requested);
}

function isPlaceableBlock(name: string, registry: BuildBlockRegistry): boolean {
  return hasOwn(registry.blocksByName, name) && hasOwn(registry.itemsByName, name);
}

function hasOwn(record: Readonly<Record<string, unknown>>, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(record, key) && record[key] !== undefined && record[key] !== null;
}

function readVersion(value: unknown): string | undefined {
  if (typeof value === "string" && value.trim()) return value.trim();
  if (typeof value !== "object" || value === null) return undefined;
  const candidate = value as { minecraftVersion?: unknown; version?: unknown };
  if (typeof candidate.minecraftVersion === "string" && candidate.minecraftVersion.trim()) {
    return candidate.minecraftVersion.trim();
  }
  if (typeof candidate.version === "string" && candidate.version.trim()) return candidate.version.trim();
  return undefined;
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
