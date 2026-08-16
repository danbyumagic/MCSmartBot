import type { Bot } from "mineflayer";
import type { Entity } from "prismarine-entity";
import { Vec3 } from "vec3";
import pathfinderPkg from "mineflayer-pathfinder";
import {
  ensurePathfinder,
  isFlightEnabled,
  setFlightEnabled,
  setFlightMotionActive,
} from "./pathfinder.js";

const { goals } = pathfinderPkg;

export interface FlightTelemetry {
  mode: "flight";
  segments: number;
  distance: number;
}

type WritableClient = { write(name: string, params: Record<string, unknown>): void };

function writeFlyingFlag(bot: Bot, flying: boolean): void {
  // ServerboundPlayerAbilitiesPacket: bit 0x02 means the player is currently
  // flying. This is the packet the vanilla client sends after a creative
  // double-jump or after toggling flight granted by /fly.
  const client = (bot as Bot & { _client?: WritableClient })._client;
  client?.write("abilities", { flags: flying ? 0x02 : 0x00 });
}

function ensureCreativeFlightApi(bot: Bot): void {
  if (
    typeof bot.creative?.startFlying !== "function" ||
    typeof bot.creative?.stopFlying !== "function" ||
    typeof bot.creative?.flyTo !== "function"
  ) {
    throw new Error("mineflayer creative flight API is unavailable");
  }
}

export function gameModeAllowsFlight(bot: Bot): boolean {
  return bot.game?.gameMode === "creative" || bot.game?.gameMode === "spectator";
}

export async function activateFlight(bot: Bot, takeoff = true): Promise<void> {
  ensureCreativeFlightApi(bot);
  setFlightEnabled(bot, true);
  writeFlyingFlag(bot, true);
  bot.creative.startFlying();

  // A small upward move makes activation equivalent to the vanilla
  // double-jump instead of merely disabling local gravity at ground level.
  if (takeoff && bot.entity?.position) {
    await bot.creative.flyTo(bot.entity.position.offset(0, 1.25, 0));
  }
}

export function resumeFlight(bot: Bot): void {
  ensureCreativeFlightApi(bot);
  setFlightMotionActive(bot, true);
  writeFlyingFlag(bot, true);
  bot.creative.startFlying();
}

/** Stop airborne physics but retain the granted/configured flight capability. */
export function suspendFlight(bot: Bot): void {
  writeFlyingFlag(bot, false);
  bot.creative?.stopFlying?.();
  bot.clearControlStates?.();
  setFlightMotionActive(bot, false);
}

export function deactivateFlight(bot: Bot): void {
  suspendFlight(bot);
  setFlightEnabled(bot, false);
}

export async function flyToPosition(
  bot: Bot,
  destination: Vec3,
  range: number,
  signal: AbortSignal,
): Promise<FlightTelemetry> {
  if (!isFlightEnabled()) throw new Error("flight is not enabled");
  ensureCreativeFlightApi(bot);
  if (!bot.entity?.position) throw new Error("bot has not spawned");
  resumeFlight(bot);

  const start = bot.entity.position.clone();
  let segments = 0;
  while (bot.entity.position.distanceTo(destination) > range) {
    if (signal.aborted) throw new Error("aborted");
    const current = bot.entity.position.clone();
    const delta = destination.minus(current);
    const remaining = Math.sqrt(delta.x * delta.x + delta.y * delta.y + delta.z * delta.z);
    const travel = Math.min(4, Math.max(0.25, remaining - range));
    const next = current.plus(delta.scaled(travel / remaining));
    await bot.creative.flyTo(next);
    segments++;
    if (bot.entity.position.distanceTo(current) < 0.05) {
      throw new Error("flight stalled without changing position");
    }
  }
  return {
    mode: "flight",
    segments,
    distance: start.distanceTo(bot.entity.position),
  };
}

function abortableDelay(ms: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.reject(new Error("aborted"));
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(new Error("aborted"));
    };
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

export async function flyFollowUntilAborted(
  bot: Bot,
  resolveEntity: () => Entity | undefined,
  range: number,
  signal: AbortSignal,
): Promise<never> {
  if (!isFlightEnabled()) throw new Error("flight is not enabled");
  let missingSince: number | undefined;
  while (true) {
    if (signal.aborted) throw new Error("aborted");
    const target = resolveEntity();
    if (!target?.position) {
      missingSince ??= Date.now();
      if (Date.now() - missingSince >= 10_000) {
        throw new Error("flight target was unavailable for 10 seconds");
      }
      await abortableDelay(250, signal);
      continue;
    }
    missingSince = undefined;
    if (!bot.entity?.position) throw new Error("bot has not spawned");
    if (bot.entity.position.distanceTo(target.position) > range) {
      await flyToPosition(bot, target.position.clone(), range, signal);
    }
    await abortableDelay(200, signal);
  }
}

export interface AdaptiveFollowTarget {
  entity: Entity;
  flying: boolean;
}

/**
 * Follow using normal pathfinding on land/in water and switch to true 3D flight
 * only while the target is flying. Flight permission remains enabled across
 * mode switches, so landing does not toggle the server's /fly grant off.
 */
export async function adaptiveFollowUntilAborted(
  bot: Bot,
  resolveTarget: () => AdaptiveFollowTarget | undefined,
  range: number,
  signal: AbortSignal,
): Promise<never> {
  if (!isFlightEnabled()) throw new Error("flight is not enabled");
  ensurePathfinder(bot);
  let mode: "ground" | "flight" | null = null;
  let followedEntity: Entity | undefined;
  let missingSince: number | undefined;
  try {
    while (true) {
      if (signal.aborted) throw new Error("aborted");
      const target = resolveTarget();
      if (!target?.entity?.position) {
        missingSince ??= Date.now();
        if (Date.now() - missingSince >= 10_000) {
          throw new Error("adaptive follow target was unavailable for 10 seconds");
        }
        await abortableDelay(250, signal);
        continue;
      }
      missingSince = undefined;

      if (target.flying) {
        if (mode !== "flight") {
          bot.pathfinder.setGoal(null);
          bot.clearControlStates();
          resumeFlight(bot);
          mode = "flight";
        }
        await flyToPosition(bot, target.entity.position.clone(), range, signal);
      } else {
        if (mode === "flight" && bot.entity?.position.distanceTo(target.entity.position) > range) {
          // Descend beside the player before restoring gravity.
          await flyToPosition(bot, target.entity.position.clone(), range, signal);
        }
        if (mode !== "ground" || followedEntity !== target.entity) {
          suspendFlight(bot);
          bot.pathfinder.setGoal(new goals.GoalFollow(target.entity, range), true);
          followedEntity = target.entity;
          mode = "ground";
        }
      }
      await abortableDelay(200, signal);
    }
  } finally {
    try {
      bot.pathfinder.setGoal(null);
      bot.clearControlStates();
    } catch {
      // best-effort emergency cleanup
    }
  }
}
