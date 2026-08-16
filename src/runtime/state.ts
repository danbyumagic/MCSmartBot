import type { InventorySnapshot } from "../inventory/snapshot.js";

export interface EmergencyStopResult {
  activeSkill: string | null;
  discardedTriggers: number;
  agentCancelled: boolean;
  pausedPlanId: number | null;
}

export interface BotRuntimeState {
  connection: string;
  activeSkill: string | null;
  health: number | null;
  food: number | null;
  dimension: string | null;
  position: { x: number; y: number; z: number } | null;
  inventory: InventorySnapshot | null;
}

export function disconnectedRuntimeState(connection: string): BotRuntimeState {
  return {
    connection,
    activeSkill: null,
    health: null,
    food: null,
    dimension: null,
    position: null,
    inventory: null,
  };
}
