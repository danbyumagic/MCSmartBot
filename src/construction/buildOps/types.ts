/**
 * Typed, pure BuildOps v1 data. These relative placements deliberately contain
 * no live Mineflayer objects, arbitrary state strings, or execution handles.
 */

export const BUILDOPS_SCHEMA = "smartbot.build/v1" as const;
export const BUILDOPS_ASCII_SCHEMA = "smartbot.build-ascii/v1" as const;

export type Vec3Tuple = [number, number, number];

export interface BuildDefinition {
  readonly schema: typeof BUILDOPS_SCHEMA;
  readonly name: string;
  readonly targetVersion: string;
  readonly ops: readonly BuildOperation[];
}

interface NamedOperation {
  /** Optional human-readable diagnostic label; present labels must be unique. */
  readonly name?: string;
}

export interface PutOperation extends NamedOperation {
  readonly op: "put";
  readonly at: Vec3Tuple;
  readonly block: string;
}

export interface BoxOperation extends NamedOperation {
  readonly op: "box";
  readonly from: Vec3Tuple;
  readonly to: Vec3Tuple;
  readonly block: string;
  readonly mode: "solid" | "hollow" | "outline";
}

export interface WallsOperation extends NamedOperation {
  readonly op: "walls";
  readonly from: Vec3Tuple;
  readonly to: Vec3Tuple;
  readonly block: string;
  readonly thickness: number;
}

export interface FloorOperation extends NamedOperation {
  readonly op: "floor";
  readonly from: Vec3Tuple;
  readonly to: Vec3Tuple;
  readonly block: string;
}

export interface CylinderOperation extends NamedOperation {
  readonly op: "cylinder";
  readonly center: Vec3Tuple;
  readonly radius: number;
  /** Inclusive vertical count starting at `center[1]`. */
  readonly height: number;
  readonly block: string;
  readonly mode: "filled" | "hollow";
}

export interface DiscOperation extends NamedOperation {
  readonly op: "disc";
  readonly center: Vec3Tuple;
  readonly radius: number;
  readonly block: string;
}

export interface RingOperation extends NamedOperation {
  readonly op: "ring";
  readonly center: Vec3Tuple;
  readonly radius: number;
  readonly block: string;
}

export interface PunchOperation extends NamedOperation {
  readonly op: "punch";
  readonly from: Vec3Tuple;
  readonly to: Vec3Tuple;
}

export interface WindowOperation extends NamedOperation {
  readonly op: "window";
  readonly from: Vec3Tuple;
  readonly to: Vec3Tuple;
  readonly block: string;
}

/** A pitched roof whose `from`/`to` box describes eaves through ridge height. */
export interface GableRoofOperation extends NamedOperation {
  readonly op: "gableRoof";
  readonly from: Vec3Tuple;
  readonly to: Vec3Tuple;
  /** Horizontal axis followed by the ridge; slopes descend along the other axis. */
  readonly ridge: "x" | "z";
  readonly block: string;
}

export interface CurvedWallOperation extends NamedOperation {
  readonly op: "curvedWall";
  readonly center: Vec3Tuple;
  readonly radius: number;
  /** Inclusive start of an arc in degrees; zero points east (+X). */
  readonly startAngle: number;
  /** Inclusive end of an arc in degrees; an equal value means one full turn. */
  readonly endAngle: number;
  readonly height: number;
  readonly thickness: number;
  readonly block: string;
}

export interface DomeOperation extends NamedOperation {
  readonly op: "dome";
  /** Centre of the dome's ground plane; generated cells extend upward only. */
  readonly center: Vec3Tuple;
  readonly radius: number;
  readonly block: string;
  readonly mode: "filled" | "hollow";
  readonly thickness: number;
}

export interface SpiralStairsOperation extends NamedOperation {
  readonly op: "spiralStairs";
  readonly center: Vec3Tuple;
  readonly radius: number;
  readonly height: number;
  readonly turns: number;
  readonly clockwise: boolean;
  readonly block: string;
}

/** Copy currently proposed cells in this inclusive canvas region without removing the source. */
export interface CopyOperation extends NamedOperation {
  readonly op: "copy";
  readonly from: Vec3Tuple;
  readonly to: Vec3Tuple;
  readonly offset: Vec3Tuple;
}

/** Rotate currently proposed cells around a vertical pivot without removing the source. */
export interface RotateOperation extends NamedOperation {
  readonly op: "rotate";
  readonly from: Vec3Tuple;
  readonly to: Vec3Tuple;
  readonly pivot: Vec3Tuple;
  /** Clockwise quarter-turns, where one maps north-facing hints to east. */
  readonly quarterTurns: 1 | 2 | 3;
}

/** Mirror currently proposed cells across a vertical axis through `pivot` without removing the source. */
export interface MirrorOperation extends NamedOperation {
  readonly op: "mirror";
  readonly from: Vec3Tuple;
  readonly to: Vec3Tuple;
  readonly pivot: Vec3Tuple;
  /** `x` reflects X and swaps east/west hints; `z` reflects Z and swaps north/south. */
  readonly axis: "x" | "z";
}

export type BuildOperation =
  | PutOperation
  | BoxOperation
  | WallsOperation
  | FloorOperation
  | CylinderOperation
  | DiscOperation
  | RingOperation
  | PunchOperation
  | WindowOperation
  | GableRoofOperation
  | CurvedWallOperation
  | DomeOperation
  | SpiralStairsOperation
  | CopyOperation
  | RotateOperation
  | MirrorOperation;

export interface BuildAsciiLayer {
  /** Relative y coordinate for this top-down layer. Layers apply in array order. */
  readonly y: number;
  /** Rectangular row grid: row zero is north and each row begins in the west. */
  readonly rows: readonly string[];
}

export interface BuildAsciiDefinition {
  readonly schema: typeof BUILDOPS_ASCII_SCHEMA;
  readonly name: string;
  readonly targetVersion: string;
  /** One non-skip character to a normal Minecraft block id. */
  readonly palette: Readonly<Record<string, string>>;
  readonly layers: readonly BuildAsciiLayer[];
}

export type BuildSourceDefinition = BuildDefinition | BuildAsciiDefinition;

export type Cardinal = "north" | "south" | "east" | "west";

/**
 * Bounded adapter request for a stateful placement. It is deliberately not a
 * Minecraft block-state string and must be rejected by execution until the
 * selected adapter proves it can place and verify the requested state.
 */
export interface PlacementHint {
  readonly facing?: Cardinal;
  readonly half?: "top" | "bottom";
}

/** One ordinary, verified-placement candidate relative to a future build origin. */
export interface BlueprintPlacement {
  readonly x: number;
  readonly y: number;
  readonly z: number;
  readonly block: string;
  readonly hint?: PlacementHint;
}

/** Alias retained for callers that prefer BuildOps wording. */
export type BuildPlacement = BlueprintPlacement;

export interface BuildBounds {
  readonly min: Vec3Tuple;
  readonly max: Vec3Tuple;
}

export type BuildAccessRequirement = "operator" | "owner";

export type BuildMaterialRisk = "normal" | "hazardous";

export interface BlockNormalizationWarning {
  readonly code: "BLOCK_NORMALIZED";
  readonly message: string;
  readonly opIndex: number;
  readonly from: string;
  readonly to: string;
}

export interface WindowEmptyWarning {
  readonly code: "WINDOW_EMPTY";
  readonly message: string;
  readonly opIndex: number;
}

export interface TransformEmptyWarning {
  readonly code: "TRANSFORM_EMPTY";
  readonly message: string;
  readonly opIndex: number;
}

export type BuildWarning = BlockNormalizationWarning | WindowEmptyWarning | TransformEmptyWarning;

export type BuildDiagnostic =
  | {
    readonly kind: "overwrite";
    readonly opIndex: number;
    readonly position: Vec3Tuple;
    readonly previous: string;
    readonly next: string;
  }
  | {
    readonly kind: "punch";
    readonly opIndex: number;
    readonly position: Vec3Tuple;
    readonly removed: string;
  };

export interface BuildCompileReport {
  readonly operationCount: number;
  /** Number of final ordinary placement units; equals worldCellCount in v1. */
  readonly placementCount: number;
  readonly worldCellCount: number;
  readonly bounds: BuildBounds;
  readonly materials: Readonly<Record<string, number>>;
  readonly overwrites: number;
  readonly punches: number;
  /** Bounded samples for preview/debugging; totals remain available above. */
  readonly diagnostics: readonly BuildDiagnostic[];
  readonly warnings: readonly BuildWarning[];
  readonly requiredAccess: BuildAccessRequirement;
  readonly sourceHash: string;
}

export interface CompiledBuild {
  readonly schema: typeof BUILDOPS_SCHEMA | typeof BUILDOPS_ASCII_SCHEMA;
  readonly name: string;
  readonly targetVersion: string;
  /** Internal/trusted callers may consume all cells; agent summaries use report. */
  readonly placements: readonly BlueprintPlacement[];
  readonly report: BuildCompileReport;
}

export type BuildCompileErrorCode =
  | "SCHEMA_INVALID"
  | "VERSION_MISMATCH"
  | "COORDINATE_OUT_OF_RANGE"
  | "OPERATION_CELL_LIMIT"
  | "OUTPUT_CELL_LIMIT"
  | "EMPTY_BUILD"
  | "BLOCK_UNKNOWN"
  | "BLOCK_AMBIGUOUS"
  | "BLOCK_NOT_PLACEABLE"
  | "BLOCK_UNSUPPORTED";

export interface BuildCompileError {
  readonly code: BuildCompileErrorCode;
  readonly message: string;
  readonly opIndex?: number;
  readonly path?: readonly (string | number)[];
  readonly details?: Readonly<Record<string, unknown>>;
}

export type BuildCompileResult =
  | { readonly ok: true; readonly value: CompiledBuild }
  | { readonly ok: false; readonly errors: readonly BuildCompileError[] };

/** Minimal registry shape that works with minecraft-data and a connected Bot registry. */
export interface BuildBlockRegistry {
  readonly version: string;
  readonly blocksByName: Readonly<Record<string, unknown>>;
  readonly itemsByName: Readonly<Record<string, unknown>>;
}

export interface NormalizedBlock {
  readonly block: string;
  readonly item: string;
  readonly risk: BuildMaterialRisk;
  readonly warning?: Omit<BlockNormalizationWarning, "opIndex">;
}
