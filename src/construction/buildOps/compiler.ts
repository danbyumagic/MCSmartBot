// Portions adapted from https://github.com/NoblerWorks-HQ/minecraft-agentic,
// src/ops.js @ 7e2590d9150e47956371e610e1f3ac050d3f7ad2 and
// src/library/canvas.js @ 7e2590d9150e47956371e610e1f3ac050d3f7ad2.
// Licensed under MIT; see LICENSES/minecraft-agentic-MIT.txt.
// Modified for SmartBotMC: strict v1 parsing, injected version-aware registry,
// fail-closed limits, no roles/randomness/world execution, and audit reports.

import { createHash } from "node:crypto";
import { expandAsciiLayer } from "./ascii.js";
import {
  BuildCanvas,
  coordinateKey,
  discOffsets,
  inclusiveBounds,
  ringOffsets,
} from "./canvas.js";
import { classifyBuildBlock, normalizeBuildBlock } from "./blockRegistry.js";
import { generateAdvancedPlacements, transformSnapshot } from "./geometry.js";
import {
  isBuildCoordinate,
  resolveBuildOpsLimits,
  type BuildOpsLimitOverrides,
  type BuildOpsLimits,
} from "./limits.js";
import { safeParseBuildSource } from "./schema.js";
import type {
  BlueprintPlacement,
  BuildAsciiDefinition,
  BuildBlockRegistry,
  BuildBounds,
  BuildCompileError,
  BuildCompileResult,
  BuildDefinition,
  BuildDiagnostic,
  BuildOperation,
  BuildSourceDefinition,
  BuildWarning,
  CompiledBuild,
  PlacementHint,
  Vec3Tuple,
} from "./types.js";

export interface BuildCompileOptions {
  readonly registry: BuildBlockRegistry;
  /** May lower hard caps for preview/testing, never raise them. */
  readonly limits?: BuildOpsLimitOverrides;
}

export interface VersionedBuildCompileOptions {
  readonly registryForVersion: (targetVersion: string) => BuildBlockRegistry | undefined;
  readonly limits?: BuildOpsLimitOverrides;
}

/** Compile one strict compact-ops or ASCII definition against an exact version-aware registry. */
export function compileBuildDefinition(
  input: unknown,
  options: BuildCompileOptions,
): BuildCompileResult {
  const parsed = parseInput(input);
  if (!parsed.ok) return parsed;
  return compileParsedBuildSource(parsed.definition, options.registry, options.limits);
}

/** Explicit source-named alias for callers that accept either BuildOps envelope. */
export const compileBuildSource = compileBuildDefinition;

/** Resolve the source's exact target version before compiling it. */
export function compileBuildDefinitionForVersion(
  input: unknown,
  options: VersionedBuildCompileOptions,
): BuildCompileResult {
  const parsed = parseInput(input);
  if (!parsed.ok) return parsed;
  let registry: BuildBlockRegistry | undefined;
  try {
    registry = options.registryForVersion(parsed.definition.targetVersion);
  } catch (error) {
    return fail("VERSION_MISMATCH", `could not resolve Minecraft ${parsed.definition.targetVersion}: ${errorMessage(error)}`);
  }
  if (!registry) {
    return fail("VERSION_MISMATCH", `no BuildOps registry is available for Minecraft ${parsed.definition.targetVersion}`, {
      targetVersion: parsed.definition.targetVersion,
    });
  }
  return compileParsedBuildSource(parsed.definition, registry, options.limits);
}

/** Convenience direct-registry form for internal callers and focused tests. */
export function compileBuildDefinitionWithRegistry(
  input: unknown,
  registry: BuildBlockRegistry,
  limits?: BuildOpsLimitOverrides,
): BuildCompileResult {
  return compileBuildDefinition(input, { registry, limits });
}

/** Throwing convenience for trusted callers that already expose validation diagnostics elsewhere. */
export function compileBuildDefinitionOrThrow(
  input: unknown,
  options: BuildCompileOptions,
): CompiledBuild {
  const result = compileBuildDefinition(input, options);
  if (result.ok) return result.value;
  throw new BuildCompilationError(result.errors);
}

export class BuildCompilationError extends Error {
  constructor(public readonly errors: readonly BuildCompileError[]) {
    super(errors.map((error) => error.message).join("; "));
    this.name = "BuildCompilationError";
  }
}

/** Stable JSON source representation used solely for audit/deduplication metadata. */
export function canonicalizeBuildSource(definition: BuildSourceDefinition): string {
  return canonicalJson(definition);
}

/** SHA-256 of the parsed, canonical source—not of generated placements or diagnostics. */
export function hashBuildSource(definition: BuildSourceDefinition): string {
  return createHash("sha256").update(canonicalizeBuildSource(definition)).digest("hex");
}

function compileParsedBuildSource(
  definition: BuildSourceDefinition,
  registry: BuildBlockRegistry,
  limitOverrides?: BuildOpsLimitOverrides,
): BuildCompileResult {
  let limits: BuildOpsLimits;
  try {
    limits = resolveBuildOpsLimits(limitOverrides);
  } catch (error) {
    // Limit overrides are trusted application configuration, but returning a
    // structured error keeps preview consumers from receiving a partial build.
    return fail("SCHEMA_INVALID", `invalid BuildOps compiler limits: ${errorMessage(error)}`);
  }
  if (definition.targetVersion !== registry.version) {
    return fail(
      "VERSION_MISMATCH",
      `BuildOps source targets Minecraft ${definition.targetVersion}, but registry is ${registry.version}`,
      { targetVersion: definition.targetVersion, registryVersion: registry.version },
    );
  }
  const operationCount = definition.schema === "smartbot.build/v1"
    ? definition.ops.length
    : definition.layers.length;
  if (operationCount > limits.maxOperations) {
    return fail(
      "SCHEMA_INVALID",
      `BuildOps source has ${operationCount} operations; maximum is ${limits.maxOperations}`,
      { actual: operationCount, maximum: limits.maxOperations },
    );
  }

  const context: CompileContext = {
    canvas: new BuildCanvas(),
    registry,
    limits,
    warnings: [],
  };
  const error = definition.schema === "smartbot.build/v1"
    ? compileCompactDefinition(definition, context)
    : compileAsciiDefinition(definition, context);
  if (error) return { ok: false, errors: [error] };
  return finalizeCompilation(definition, context, operationCount);
}

interface CompileContext {
  readonly canvas: BuildCanvas;
  readonly registry: BuildBlockRegistry;
  readonly limits: BuildOpsLimits;
  readonly warnings: BuildWarning[];
}

function compileCompactDefinition(
  definition: BuildDefinition,
  context: CompileContext,
): BuildCompileError | undefined {
  for (const [opIndex, operation] of definition.ops.entries()) {
    switch (operation.op) {
      case "punch":
        context.canvas.punch(inclusiveBounds(operation.from, operation.to), opIndex, context.limits.maxDiagnosticSamples);
        continue;
      case "window": {
        const normalized = normalizeRawBlock(operation.block, context.registry, opIndex, ["ops", opIndex, "block"]);
        if (!normalized.ok) return normalized.error;
        if (normalized.warning) context.warnings.push(normalized.warning);
        const bounds = inclusiveBounds(operation.from, operation.to);
        // Snapshot before touching the canvas. A failed/oversized window can
        // therefore never leave a partially carved proposed design behind.
        const removed = context.canvas.within(bounds);
        if (removed.length === 0) {
          context.warnings.push({
            code: "WINDOW_EMPTY",
            opIndex,
            message: `window op ${opIndex} matched no current proposed cells and glazed nothing`,
          });
          continue;
        }
        // A glazing block must not accidentally inherit a previous stair hint.
        const glaze = stagePlacements(removed.map((placement) => ({
          x: placement.x,
          y: placement.y,
          z: placement.z,
          block: normalized.block,
        })));
        const stagedError = validateStage(glaze, context.canvas, context.limits, opIndex);
        if (stagedError) return stagedError;
        context.canvas.punch(bounds, opIndex, context.limits.maxDiagnosticSamples);
        context.canvas.apply(glaze, opIndex, context.limits.maxDiagnosticSamples);
        continue;
      }
      case "copy":
      case "rotate":
      case "mirror": {
        const source = context.canvas.within(inclusiveBounds(operation.from, operation.to));
        if (source.length === 0) {
          context.warnings.push({
            code: "TRANSFORM_EMPTY",
            opIndex,
            message: `${operation.op} op ${opIndex} matched no current proposed cells and changed nothing`,
          });
          continue;
        }
        // The transform operates on this immutable snapshot, never on cells it
        // just wrote, so overlap cannot cascade or depend on map iteration.
        const staged = stagePlacements(transformSnapshot(operation, source));
        const stagedError = validateStage(staged, context.canvas, context.limits, opIndex);
        if (stagedError) return stagedError;
        context.canvas.apply(staged, opIndex, context.limits.maxDiagnosticSamples);
        continue;
      }
      default: {
        const radiusError = validateOperationRadius(operation, context.limits, opIndex);
        if (radiusError) return radiusError;
        const normalized = normalizeRawBlock(operation.block, context.registry, opIndex, ["ops", opIndex, "block"]);
        if (!normalized.ok) return normalized.error;
        if (normalized.warning) context.warnings.push(normalized.warning);
        const generated = generatePlacements(operation, normalized.block, context.limits.maxCellsPerOperation);
        if (generated.overflow) {
          return {
            code: "OPERATION_CELL_LIMIT",
            message: `operation ${opIndex} emits more than ${context.limits.maxCellsPerOperation} cells`,
            opIndex,
            details: { opIndex, op: operation.op, maximum: context.limits.maxCellsPerOperation },
          };
        }
        const stagedError = validateStage(generated.placements, context.canvas, context.limits, opIndex);
        if (stagedError) return stagedError;
        context.canvas.apply(generated.placements, opIndex, context.limits.maxDiagnosticSamples);
      }
    }
  }
  return undefined;
}

function validateOperationRadius(
  operation: DrawableBuildOperation,
  limits: BuildOpsLimits,
  opIndex: number,
): BuildCompileError | undefined {
  switch (operation.op) {
    case "cylinder":
    case "disc":
    case "ring":
    case "curvedWall":
    case "dome":
    case "spiralStairs":
      if (operation.radius <= limits.maxRadius) return undefined;
      return {
        code: "SCHEMA_INVALID",
        message: `operation ${opIndex} radius ${operation.radius} exceeds configured maximum ${limits.maxRadius}`,
        opIndex,
        details: { radius: operation.radius, maximum: limits.maxRadius },
      };
    default:
      return undefined;
  }
}

function compileAsciiDefinition(
  definition: BuildAsciiDefinition,
  context: CompileContext,
): BuildCompileError | undefined {
  if (definition.layers.length > context.limits.maxAsciiLayers) {
    return {
      code: "SCHEMA_INVALID",
      message: `ASCII source has ${definition.layers.length} layers; maximum is ${context.limits.maxAsciiLayers}`,
      details: { actual: definition.layers.length, maximum: context.limits.maxAsciiLayers },
    };
  }
  for (const [layerIndex] of definition.layers.entries()) {
    const expansion = expandAsciiLayer(definition, layerIndex, context.limits);
    if (!expansion.ok) {
      return {
        code: "SCHEMA_INVALID",
        message: expansion.message,
        opIndex: layerIndex,
        details: expansion.details,
      };
    }
    const normalizedByRawBlock = new Map<string, string>();
    const stage: BlueprintPlacement[] = [];
    for (const cell of expansion.placements) {
      let block = normalizedByRawBlock.get(cell.block);
      if (!block) {
        const normalized = normalizeRawBlock(
          cell.block,
          context.registry,
          layerIndex,
          ["layers", layerIndex, "rows", cell.row],
        );
        if (!normalized.ok) return normalized.error;
        block = normalized.block;
        normalizedByRawBlock.set(cell.block, block);
        if (normalized.warning) context.warnings.push(normalized.warning);
      }
      stage.push({ x: cell.x, y: cell.y, z: cell.z, block });
    }
    const staged = stagePlacements(stage);
    const stagedError = validateStage(staged, context.canvas, context.limits, layerIndex);
    if (stagedError) return stagedError;
    context.canvas.apply(staged, layerIndex, context.limits.maxDiagnosticSamples);
  }
  return undefined;
}

function finalizeCompilation(
  definition: BuildSourceDefinition,
  context: CompileContext,
  operationCount: number,
): BuildCompileResult {
  const placements = context.canvas.placements();
  if (placements.length === 0) {
    return fail("EMPTY_BUILD", "BuildOps source produces no final placement cells");
  }
  const bounds = placementBounds(placements);
  const materials = materialTotals(placements);
  const requiredAccess = placements.some((placement) => classifyBuildBlock(placement.block) === "hazardous")
    ? "owner"
    : "operator";
  const report = Object.freeze({
    operationCount,
    placementCount: placements.length,
    worldCellCount: placements.length,
    bounds,
    materials,
    overwrites: context.canvas.overwriteCount,
    punches: context.canvas.punchCount,
    diagnostics: context.canvas.diagnostics(),
    warnings: Object.freeze(context.warnings.slice(0, context.limits.maxOperations)),
    requiredAccess,
    sourceHash: hashBuildSource(definition),
  });
  return {
    ok: true,
    value: Object.freeze({
      schema: definition.schema,
      name: definition.name,
      targetVersion: definition.targetVersion,
      placements: Object.freeze(placements),
      report,
    }),
  };
}

function parseInput(input: unknown):
  | { readonly ok: true; readonly definition: BuildSourceDefinition }
  | { readonly ok: false; readonly errors: readonly BuildCompileError[] } {
  const parsed = safeParseBuildSource(input);
  if (parsed.success) return { ok: true, definition: parsed.data };
  return {
    ok: false,
    errors: parsed.error.issues.slice(0, 64).map((issue) => ({
      code: "SCHEMA_INVALID",
      message: issue.message,
      path: issue.path.filter((segment): segment is string | number =>
        typeof segment === "string" || typeof segment === "number"),
    })),
  };
}

function normalizeRawBlock(
  rawBlock: string,
  registry: BuildBlockRegistry,
  opIndex: number,
  path: readonly (string | number)[],
):
  | { readonly ok: true; readonly block: string; readonly warning?: BuildWarning }
  | { readonly ok: false; readonly error: BuildCompileError } {
  const normalized = normalizeBuildBlock(rawBlock, registry);
  if (!normalized.ok) {
    return {
      ok: false,
      error: { ...normalized.error, opIndex, path },
    };
  }
  return {
    ok: true,
    block: normalized.value.block,
    ...(normalized.value.warning ? {
      warning: { ...normalized.value.warning, opIndex },
    } : {}),
  };
}

type DrawableBuildOperation = Exclude<BuildOperation, {
  op: "punch" | "window" | "copy" | "rotate" | "mirror";
}>;

function generatePlacements(
  operation: DrawableBuildOperation,
  block: string,
  maxCells: number,
): { readonly placements: readonly BlueprintPlacement[]; readonly overflow: boolean } {
  switch (operation.op) {
    case "gableRoof":
    case "curvedWall":
    case "dome":
    case "spiralStairs":
      return generateAdvancedPlacements(operation, block, maxCells);
    default:
      return generateInitialPlacements(operation, block, maxCells);
  }
}

type InitialDrawableOperation = Exclude<DrawableBuildOperation, {
  op: "gableRoof" | "curvedWall" | "dome" | "spiralStairs";
}>;

function generateInitialPlacements(
  operation: InitialDrawableOperation,
  block: string,
  maxCells: number,
): { readonly placements: readonly BlueprintPlacement[]; readonly overflow: boolean } {
  const collector = new PlacementCollector(maxCells);
  switch (operation.op) {
    case "put":
      collector.add(operation.at[0], operation.at[1], operation.at[2], block);
      break;
    case "box":
      emitBox(operation, block, collector);
      break;
    case "walls":
      emitWalls(operation, block, collector);
      break;
    case "floor":
      emitFloor(operation, block, collector);
      break;
    case "cylinder":
      emitCylinder(operation, block, collector);
      break;
    case "disc":
      emitDisc(operation.center, operation.radius, block, collector);
      break;
    case "ring":
      emitRing(operation.center, operation.radius, block, collector);
      break;
  }
  return { placements: collector.placements(), overflow: collector.overflow };
}

function emitBox(
  operation: Extract<BuildOperation, { op: "box" }>,
  block: string,
  collector: PlacementCollector,
): void {
  const bounds = inclusiveBounds(operation.from, operation.to);
  const [minX, minY, minZ] = bounds.min;
  const [maxX, maxY, maxZ] = bounds.max;
  for (let x = minX; x <= maxX; x++) {
    for (let y = minY; y <= maxY; y++) {
      for (let z = minZ; z <= maxZ; z++) {
        const boundaryAxes = Number(x === minX || x === maxX) +
          Number(y === minY || y === maxY) + Number(z === minZ || z === maxZ);
        if (operation.mode === "hollow" && boundaryAxes < 1) continue;
        if (operation.mode === "outline" && boundaryAxes < 2) continue;
        if (!collector.add(x, y, z, block)) return;
      }
    }
  }
}

function emitWalls(
  operation: Extract<BuildOperation, { op: "walls" }>,
  block: string,
  collector: PlacementCollector,
): void {
  const bounds = inclusiveBounds(operation.from, operation.to);
  const [minX, minY, minZ] = bounds.min;
  const [maxX, maxY, maxZ] = bounds.max;
  for (let x = minX; x <= maxX; x++) {
    for (let y = minY; y <= maxY; y++) {
      for (let z = minZ; z <= maxZ; z++) {
        const isWall = x - minX < operation.thickness || maxX - x < operation.thickness ||
          z - minZ < operation.thickness || maxZ - z < operation.thickness;
        if (isWall && !collector.add(x, y, z, block)) return;
      }
    }
  }
}

function emitFloor(
  operation: Extract<BuildOperation, { op: "floor" }>,
  block: string,
  collector: PlacementCollector,
): void {
  const bounds = inclusiveBounds(operation.from, operation.to);
  const [minX, y, minZ] = bounds.min;
  const [maxX, , maxZ] = bounds.max;
  for (let x = minX; x <= maxX; x++) {
    for (let z = minZ; z <= maxZ; z++) {
      if (!collector.add(x, y, z, block)) return;
    }
  }
}

function emitCylinder(
  operation: Extract<BuildOperation, { op: "cylinder" }>,
  block: string,
  collector: PlacementCollector,
): void {
  const offsets = operation.mode === "filled" ? discOffsets(operation.radius) : ringOffsets(operation.radius);
  const [centerX, baseY, centerZ] = operation.center;
  for (let yOffset = 0; yOffset < operation.height; yOffset++) {
    for (const [xOffset, , zOffset] of offsets) {
      if (!collector.add(centerX + xOffset, baseY + yOffset, centerZ + zOffset, block)) return;
    }
  }
}

function emitDisc(center: Vec3Tuple, radius: number, block: string, collector: PlacementCollector): void {
  for (const [xOffset, , zOffset] of discOffsets(radius)) {
    if (!collector.add(center[0] + xOffset, center[1], center[2] + zOffset, block)) return;
  }
}

function emitRing(center: Vec3Tuple, radius: number, block: string, collector: PlacementCollector): void {
  for (const [xOffset, , zOffset] of ringOffsets(radius)) {
    if (!collector.add(center[0] + xOffset, center[1], center[2] + zOffset, block)) return;
  }
}

function stagePlacements(placements: readonly BlueprintPlacement[]): readonly BlueprintPlacement[] {
  const staged = new Map<string, BlueprintPlacement>();
  for (const placement of placements) {
    staged.set(coordinateKey(placement), freezePlacement(placement));
  }
  return [...staged.values()];
}

function validateStage(
  placements: readonly BlueprintPlacement[],
  canvas: BuildCanvas,
  limits: BuildOpsLimits,
  opIndex: number,
): BuildCompileError | undefined {
  if (placements.length > limits.maxCellsPerOperation) {
    return {
      code: "OPERATION_CELL_LIMIT",
      message: `operation ${opIndex} emits ${placements.length} cells; maximum is ${limits.maxCellsPerOperation}`,
      opIndex,
      details: { emitted: placements.length, maximum: limits.maxCellsPerOperation },
    };
  }
  const invalid = placements.find((placement) =>
    !isBuildCoordinate(placement.x, limits) || !isBuildCoordinate(placement.y, limits) ||
    !isBuildCoordinate(placement.z, limits));
  if (invalid) {
    return {
      code: "COORDINATE_OUT_OF_RANGE",
      message: `operation ${opIndex} derives coordinate ${invalid.x},${invalid.y},${invalid.z} outside ${limits.minCoordinate}..${limits.maxCoordinate}`,
      opIndex,
      details: {
        position: [invalid.x, invalid.y, invalid.z],
        minimum: limits.minCoordinate,
        maximum: limits.maxCoordinate,
      },
    };
  }
  const projected = canvas.projectedSize(placements);
  if (projected > limits.maxWorldCells) {
    return {
      code: "OUTPUT_CELL_LIMIT",
      message: `operation ${opIndex} would produce ${projected} final world cells; maximum is ${limits.maxWorldCells}`,
      opIndex,
      details: { projected, maximum: limits.maxWorldCells },
    };
  }
  return undefined;
}

function placementBounds(placements: readonly BlueprintPlacement[]): BuildBounds {
  let minX = placements[0]!.x;
  let minY = placements[0]!.y;
  let minZ = placements[0]!.z;
  let maxX = minX;
  let maxY = minY;
  let maxZ = minZ;
  for (const placement of placements.slice(1)) {
    minX = Math.min(minX, placement.x);
    minY = Math.min(minY, placement.y);
    minZ = Math.min(minZ, placement.z);
    maxX = Math.max(maxX, placement.x);
    maxY = Math.max(maxY, placement.y);
    maxZ = Math.max(maxZ, placement.z);
  }
  return Object.freeze({
    min: Object.freeze([minX, minY, minZ]) as Vec3Tuple,
    max: Object.freeze([maxX, maxY, maxZ]) as Vec3Tuple,
  });
}

function materialTotals(placements: readonly BlueprintPlacement[]): Readonly<Record<string, number>> {
  const totals = new Map<string, number>();
  for (const placement of placements) {
    totals.set(placement.block, (totals.get(placement.block) ?? 0) + 1);
  }
  return Object.freeze(Object.fromEntries([...totals.entries()].sort(([left], [right]) =>
    left.localeCompare(right))));
}

function fail(
  code: BuildCompileError["code"],
  message: string,
  details?: Readonly<Record<string, unknown>>,
  opIndex?: number,
): BuildCompileResult {
  return {
    ok: false,
    errors: [{
      code,
      message,
      ...(opIndex === undefined ? {} : { opIndex }),
      ...(details ? { details } : {}),
    }],
  };
}

class PlacementCollector {
  readonly #placements = new Map<string, BlueprintPlacement>();
  #overflow = false;

  constructor(private readonly maxCells: number) {}

  get overflow(): boolean {
    return this.#overflow;
  }

  add(x: number, y: number, z: number, block: string, hint?: PlacementHint): boolean {
    const placement: BlueprintPlacement = {
      x,
      y,
      z,
      block,
      ...(hint ? { hint } : {}),
    };
    const key = coordinateKey(placement);
    if (this.#placements.has(key)) {
      this.#placements.set(key, placement);
      return true;
    }
    if (this.#placements.size >= this.maxCells) {
      this.#overflow = true;
      return false;
    }
    this.#placements.set(key, placement);
    return true;
  }

  placements(): readonly BlueprintPlacement[] {
    return stagePlacements([...this.#placements.values()]);
  }
}

function freezePlacement(placement: BlueprintPlacement): BlueprintPlacement {
  const hint = placement.hint
    ? Object.freeze({
      ...(placement.hint.facing ? { facing: placement.hint.facing } : {}),
      ...(placement.hint.half ? { half: placement.hint.half } : {}),
    })
    : undefined;
  return Object.freeze({
    x: placement.x,
    y: placement.y,
    z: placement.z,
    block: placement.block,
    ...(hint ? { hint } : {}),
  });
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value === "boolean" || typeof value === "number" || typeof value === "string") {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, entry]) => entry !== undefined)
      .sort(([left], [right]) => left.localeCompare(right));
    return `{${entries.map(([key, entry]) => `${JSON.stringify(key)}:${canonicalJson(entry)}`).join(",")}}`;
  }
  throw new Error("BuildOps canonical JSON accepts parsed JSON values only");
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
