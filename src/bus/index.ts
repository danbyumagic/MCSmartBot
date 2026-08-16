import { EventEmitter } from "node:events";
import type { SkillErrorCode } from "../skills/types.js";

export type AppEvents = {
  // Mineflayer chat (filtered through chat surface in later task)
  chat: { from: string; text: string; whisper: boolean };

  // Lifecycle
  "bot.ready": void;
  "bot.end": { reason: string };
  "world.event": WorldEvent;

  // Agent triggers
  "agent.trigger": AgentTrigger;
};

export type EventSeverity = "info" | "warning" | "critical";

export interface WorldEvent {
  type: string;
  severity: EventSeverity;
  summary: string;
  details?: Record<string, unknown>;
}

export type AgentTrigger =
  | { kind: "chat"; from: string; text: string }
  | { kind: "cli"; text: string; executionSource?: "cli" | "desktop" }
  | { kind: "skillDone"; skill: string; ok: boolean; summary: string }
  | {
      kind: "skillFailed";
      skill: string;
      error: string;
      code: SkillErrorCode;
      recoverable: boolean;
      details?: Record<string, unknown>;
    }
  | { kind: "reflexAlert"; summary: string }
  | { kind: "taskPlanDone"; planId: number; title: string }
  | { kind: "taskPlanFailed"; planId: number; title: string; error: string }
  | { kind: "botDeath" }
  | { kind: "botRespawn" }
  | { kind: "idleTick" };

export interface Bus {
  on<K extends keyof AppEvents>(event: K, listener: (payload: AppEvents[K]) => void): void;
  off<K extends keyof AppEvents>(event: K, listener: (payload: AppEvents[K]) => void): void;
  emit<K extends keyof AppEvents>(event: K, payload: AppEvents[K]): void;
}

export function createBus(): Bus {
  const ee = new EventEmitter();
  ee.setMaxListeners(50);
  return {
    on: (event, listener) => void ee.on(event as string, listener as (p: unknown) => void),
    off: (event, listener) => void ee.off(event as string, listener as (p: unknown) => void),
    emit: (event, payload) => void ee.emit(event as string, payload),
  };
}
