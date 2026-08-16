import type { Vec3Tuple } from "./types.js";

/** Hard ceilings for the pure BuildOps v1 compiler. Callers may lower, never raise, them. */
export interface BuildOpsLimits {
  readonly maxOperations: number;
  readonly maxCellsPerOperation: number;
  readonly maxWorldCells: number;
  readonly maxAsciiWidth: number;
  readonly maxAsciiDepth: number;
  readonly maxAsciiLayers: number;
  readonly minCoordinate: number;
  readonly maxCoordinate: number;
  readonly maxRadius: number;
  readonly maxDiagnosticSamples: number;
}

export const BUILDOPS_LIMITS: BuildOpsLimits = Object.freeze({
  maxOperations: 128,
  maxCellsPerOperation: 2_048,
  maxWorldCells: 4_096,
  maxAsciiWidth: 129,
  maxAsciiDepth: 129,
  maxAsciiLayers: 64,
  minCoordinate: -64,
  maxCoordinate: 64,
  maxRadius: 32,
  maxDiagnosticSamples: 64,
});
export type BuildOpsLimitOverrides = Partial<BuildOpsLimits>;

/** Resolve a test/preview-specific lower budget without permitting cap escalation. */
export function resolveBuildOpsLimits(overrides?: BuildOpsLimitOverrides): BuildOpsLimits {
  if (!overrides) return BUILDOPS_LIMITS;
  const resolved = {
    maxOperations: lowerPositive("maxOperations", overrides.maxOperations, BUILDOPS_LIMITS.maxOperations),
    maxCellsPerOperation: lowerPositive(
      "maxCellsPerOperation",
      overrides.maxCellsPerOperation,
      BUILDOPS_LIMITS.maxCellsPerOperation,
    ),
    maxWorldCells: lowerPositive("maxWorldCells", overrides.maxWorldCells, BUILDOPS_LIMITS.maxWorldCells),
    maxAsciiWidth: lowerPositive("maxAsciiWidth", overrides.maxAsciiWidth, BUILDOPS_LIMITS.maxAsciiWidth),
    maxAsciiDepth: lowerPositive("maxAsciiDepth", overrides.maxAsciiDepth, BUILDOPS_LIMITS.maxAsciiDepth),
    maxAsciiLayers: lowerPositive("maxAsciiLayers", overrides.maxAsciiLayers, BUILDOPS_LIMITS.maxAsciiLayers),
    minCoordinate: lowerMinimum("minCoordinate", overrides.minCoordinate, BUILDOPS_LIMITS.minCoordinate),
    maxCoordinate: lowerMaximum("maxCoordinate", overrides.maxCoordinate, BUILDOPS_LIMITS.maxCoordinate),
    maxRadius: lowerPositive("maxRadius", overrides.maxRadius, BUILDOPS_LIMITS.maxRadius),
    maxDiagnosticSamples: lowerNonNegative(
      "maxDiagnosticSamples",
      overrides.maxDiagnosticSamples,
      BUILDOPS_LIMITS.maxDiagnosticSamples,
    ),
  } as const;
  if (resolved.minCoordinate > resolved.maxCoordinate) {
    throw new Error("BuildOps coordinate limits are inverted");
  }
  return Object.freeze(resolved);
}

export function isBuildCoordinate(value: number, limits: BuildOpsLimits = BUILDOPS_LIMITS): boolean {
  return Number.isSafeInteger(value) && value >= limits.minCoordinate && value <= limits.maxCoordinate;
}

export function isBuildPosition(value: Vec3Tuple, limits: BuildOpsLimits = BUILDOPS_LIMITS): boolean {
  return value.every((coordinate) => isBuildCoordinate(coordinate, limits));
}

function lowerPositive(name: string, value: unknown, ceiling: number): number {
  if (value === undefined) return ceiling;
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1 || value > ceiling) {
    throw new Error(`${name} must be an integer from 1 through ${ceiling}`);
  }
  return value;
}

function lowerNonNegative(name: string, value: unknown, ceiling: number): number {
  if (value === undefined) return ceiling;
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0 || value > ceiling) {
    throw new Error(`${name} must be an integer from 0 through ${ceiling}`);
  }
  return value;
}

function lowerMinimum(name: string, value: unknown, ceiling: number): number {
  if (value === undefined) return ceiling;
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < ceiling || value > Math.abs(ceiling)) {
    throw new Error(`${name} must be an integer from ${ceiling} through ${Math.abs(ceiling)}`);
  }
  return value;
}

function lowerMaximum(name: string, value: unknown, ceiling: number): number {
  if (value === undefined) return ceiling;
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value > ceiling || value < -ceiling) {
    throw new Error(`${name} must be an integer from ${-ceiling} through ${ceiling}`);
  }
  return value;
}
