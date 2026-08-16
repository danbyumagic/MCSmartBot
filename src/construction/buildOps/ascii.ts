// Portions adapted from https://github.com/brian-mwirigi/cobble-mcp,
// src/bot/design.ts @ 47edea1a9cc965776c578d66d24233bc9563dd2f.
// Licensed under MIT; see LICENSES/cobble-mcp-MIT.txt.
// Modified for SmartBotMC: strict schema-backed rectangular layers, centered
// relative coordinates, skip-without-air semantics, and no bot/world execution.

import type { BuildOpsLimits } from "./limits.js";
import type { BuildAsciiDefinition, BuildAsciiLayer, BlueprintPlacement } from "./types.js";

export const DEFAULT_ASCII_SKIP_CHARACTERS: ReadonlySet<string> = new Set([" ", ".", "_", "-"]);

export interface AsciiLayerCell extends BlueprintPlacement {
  readonly row: number;
  readonly column: number;
}

export type AsciiLayerExpansionResult =
  | { readonly ok: true; readonly placements: readonly AsciiLayerCell[] }
  | { readonly ok: false; readonly message: string; readonly details: Readonly<Record<string, unknown>> };

/**
 * Expand one already-validated layer. Its non-skip cells are ordinary proposed
 * placement candidates; skip characters intentionally create neither air nor
 * a punch/dig request.
 */
export function expandAsciiLayer(
  definition: BuildAsciiDefinition,
  layerIndex: number,
  limits: BuildOpsLimits,
): AsciiLayerExpansionResult {
  const layer = definition.layers[layerIndex];
  if (!layer) {
    return {
      ok: false,
      message: `ASCII layer ${layerIndex} does not exist`,
      details: { layerIndex },
    };
  }
  return expandLayer(definition.palette, layer, layerIndex, limits);
}

function expandLayer(
  palette: Readonly<Record<string, string>>,
  layer: BuildAsciiLayer,
  layerIndex: number,
  limits: BuildOpsLimits,
): AsciiLayerExpansionResult {
  if (layer.rows.length > limits.maxAsciiDepth) {
    return limitError("depth", layerIndex, layer.rows.length, limits.maxAsciiDepth);
  }
  const width = layer.rows[0]?.length ?? 0;
  if (width === 0) {
    return {
      ok: false,
      message: `ASCII layer ${layerIndex} has no rows`,
      details: { layerIndex },
    };
  }
  if (width > limits.maxAsciiWidth) {
    return limitError("width", layerIndex, width, limits.maxAsciiWidth);
  }
  const placements: AsciiLayerCell[] = [];
  for (const [rowIndex, row] of layer.rows.entries()) {
    if (row.length !== width) {
      return {
        ok: false,
        message: `ASCII layer ${layerIndex} row ${rowIndex} has width ${row.length}; expected ${width}`,
        details: { layerIndex, rowIndex, width: row.length, expectedWidth: width },
      };
    }
    for (const [columnIndex, character] of [...row].entries()) {
      if (DEFAULT_ASCII_SKIP_CHARACTERS.has(character)) continue;
      const block = palette[character];
      if (!block) {
        return {
          ok: false,
          message: `ASCII palette is missing character '${character}' at layer ${layerIndex}, row ${rowIndex}, column ${columnIndex}`,
          details: { layerIndex, rowIndex, columnIndex, character },
        };
      }
      placements.push({
        x: columnIndex - Math.floor(width / 2),
        y: layer.y,
        z: rowIndex - Math.floor(layer.rows.length / 2),
        block,
        row: rowIndex,
        column: columnIndex,
      });
    }
  }
  return { ok: true, placements };
}

function limitError(
  dimension: "width" | "depth",
  layerIndex: number,
  actual: number,
  maximum: number,
): AsciiLayerExpansionResult {
  return {
    ok: false,
    message: `ASCII layer ${layerIndex} ${dimension} ${actual} exceeds maximum ${maximum}`,
    details: { layerIndex, dimension, actual, maximum },
  };
}
