import type { Bot } from "mineflayer";
import pathfinderPkg from "mineflayer-pathfinder";
import type { goals as goalsNS } from "mineflayer-pathfinder";
import type { Entity } from "prismarine-entity";
import type { Vec3 } from "vec3";

const { goals, Movements, pathfinder } = pathfinderPkg;

const RECOVERY_PROFILES = [
  {
    name: "normal",
    thinkTimeoutMs: 8_000,
    canOpenDoors: false,
    allowParkour: true,
    allowEntityDetection: true,
  },
  {
    name: "stable-door-aware",
    thinkTimeoutMs: 15_000,
    canOpenDoors: true,
    allowParkour: false,
    allowEntityDetection: true,
  },
  {
    name: "relaxed-entities",
    thinkTimeoutMs: 25_000,
    canOpenDoors: true,
    allowParkour: false,
    allowEntityDetection: false,
  },
] as const;

export type PathFailureKind =
  | "timeout"
  | "no_path"
  | "goal_changed"
  | "stopped"
  | "target_unavailable"
  | "stalled"
  | "unknown";

export interface PathfindTelemetry {
  attempts: number;
  recoveries: number;
  profile: string;
}

export class PathfindingFailure extends Error {
  constructor(
    message: string,
    public readonly kind: PathFailureKind,
    public readonly attempts: number,
    public readonly profile: string,
    public readonly causeMessage: string,
  ) {
    super(message);
    this.name = "PathfindingFailure";
  }
}

let flightEnabled = false;
let flightMotionActive = false;

function buildMovements(
  bot: Bot,
  profileIndex = 0,
): InstanceType<typeof Movements> {
  const profile = RECOVERY_PROFILES[
    Math.min(profileIndex, RECOVERY_PROFILES.length - 1)
  ]!;
  const movements = new Movements(bot);
  movements.allowFreeMotion = flightMotionActive;
  movements.canOpenDoors = profile.canOpenDoors;
  movements.allowParkour = profile.allowParkour;
  movements.allowEntityDetection = profile.allowEntityDetection;
  if (flightEnabled) {
    movements.canDig = false;
  }
  return movements;
}

function configureAttempt(bot: Bot, profileIndex: number): string {
  ensurePathfinder(bot);
  const profile = RECOVERY_PROFILES[
    Math.min(profileIndex, RECOVERY_PROFILES.length - 1)
  ]!;
  bot.pathfinder.thinkTimeout = profile.thinkTimeoutMs;
  bot.pathfinder.tickTimeout = 40;
  try {
    // During partial spawn initialization the registry can be incomplete. Keep
    // the plugin's current movements in that case and still attempt the route.
    // The next recovery cycle will try to rebuild the profile again.
    bot.pathfinder.setMovements(buildMovements(bot, profileIndex));
  } catch {
    // Retaining a known movement config is safer than rejecting a route before
    // Mineflayer has had a chance to resolve it.
  }
  return profile.name;
}

export function setFlightEnabled(bot: Bot, enabled: boolean): void {
  flightEnabled = enabled;
  setFlightMotionActive(bot, enabled);
}

/** Switch pathfinder physics between ground and air without revoking /fly capability. */
export function setFlightMotionActive(bot: Bot, active: boolean): void {
  flightMotionActive = active;
  const pathfinderState = (bot as Bot & {
    pathfinder?: { setMovements?: (movements: InstanceType<typeof Movements>) => void };
  }).pathfinder;
  if (pathfinderState?.setMovements) {
    pathfinderState.setMovements(buildMovements(bot));
  }
}

export function isFlightEnabled(): boolean {
  return flightEnabled;
}

/**
 * Lazily load pathfinder. Movement settings are deliberately refreshed for
 * every navigation attempt because collectblock and other plugins may replace
 * them while gathering.
 */
export function ensurePathfinder(bot: Bot): void {
  if ((bot as Bot & { pathfinder?: unknown }).pathfinder) return;
  bot.loadPlugin(pathfinder);
  bot.pathfinder.setMovements(buildMovements(bot));
}

export async function pathfindTo(
  bot: Bot,
  goal: goalsNS.Goal,
  signal: AbortSignal,
): Promise<PathfindTelemetry> {
  ensurePathfinder(bot);
  let lastFailure: PathfindingFailure | undefined;

  for (let index = 0; index < RECOVERY_PROFILES.length; index++) {
    if (signal.aborted) throw new Error("aborted");
    if (index > 0) {
      try {
        bot.pathfinder.setGoal(null);
        bot.clearControlStates();
      } catch {
        // A reset is best-effort; the next setGoal still starts a fresh route.
      }
      await abortableDelay(250, signal);
    }

    const profile = configureAttempt(bot, index);
    try {
      await gotoWithAbort(bot, goal, signal);
      return {
        attempts: index + 1,
        recoveries: index,
        profile,
      };
    } catch (err) {
      if (signal.aborted || errorMessage(err) === "aborted") {
        throw new Error("aborted");
      }
      const causeMessage = errorMessage(err);
      const kind = classifyPathFailure(causeMessage);
      lastFailure = new PathfindingFailure(
        `pathfinding failed after ${index + 1} attempt${index === 0 ? "" : "s"} ` +
          `(${kind}): ${causeMessage}`,
        kind,
        index + 1,
        profile,
        causeMessage,
      );
      if (!isRetryablePathFailure(kind)) throw lastFailure;
    }
  }

  throw lastFailure ?? new PathfindingFailure(
    "pathfinding failed without a reported cause",
    "unknown",
    RECOVERY_PROFILES.length,
    RECOVERY_PROFILES.at(-1)!.name,
    "unknown",
  );
}

/**
 * Follow a player entity continuously while detecting lost targets, repeated
 * no-path results, and lack of physical progress. Recovery reconfigures the
 * pathfinder and rebinds GoalFollow to the latest entity object.
 */
export async function followPlayerUntilAborted(
  bot: Bot,
  resolveEntity: () => Entity | undefined,
  range: number,
  signal: AbortSignal,
): Promise<never> {
  ensurePathfinder(bot);
  if (signal.aborted) throw new Error("aborted");

  return new Promise<never>((_resolve, reject) => {
    let settled = false;
    let recoveries = 0;
    let profileIndex = 0;
    let currentEntity: Entity | undefined;
    let missingSince: number | undefined;
    let lastRecoveryAt = 0;
    let lastProgressAt = Date.now();
    let lastPosition = clonePosition(bot.entity?.position);
    let lastDistance = Number.POSITIVE_INFINITY;

    const cleanup = () => {
      clearInterval(monitor);
      signal.removeEventListener("abort", onAbort);
      bot.removeListener("path_update", onPathUpdate);
    };
    const finish = (error: Error) => {
      if (settled) return;
      settled = true;
      try {
        bot.pathfinder.setGoal(null);
        bot.clearControlStates();
      } catch {
        // best-effort shutdown
      }
      cleanup();
      reject(error);
    };
    const bindGoal = (entity: Entity) => {
      currentEntity = entity;
      const profile = configureAttempt(bot, profileIndex);
      bot.pathfinder.setGoal(new goals.GoalFollow(entity, range), true);
      lastRecoveryAt = Date.now();
      lastProgressAt = lastRecoveryAt;
      lastPosition = clonePosition(bot.entity?.position);
      lastDistance = distanceBetween(bot.entity?.position, entity.position);
      return profile;
    };
    const recover = (kind: PathFailureKind, causeMessage: string) => {
      const now = Date.now();
      if (settled || now - lastRecoveryAt < 1_000) return;
      recoveries++;
      profileIndex = Math.min(recoveries, RECOVERY_PROFILES.length - 1);
      const entity = resolveEntity();
      if (!entity) return;
      const profile = bindGoal(entity);
      if (recoveries >= RECOVERY_PROFILES.length) {
        finish(new PathfindingFailure(
          `continuous follow failed after ${recoveries} recoveries (${kind}): ${causeMessage}`,
          kind,
          recoveries + 1,
          profile,
          causeMessage,
        ));
      }
    };
    const onAbort = () => finish(new Error("aborted"));
    const onPathUpdate = (result: { status?: string }) => {
      if (result.status === "timeout") {
        recover("timeout", "pathfinder timed out while following");
      } else if (result.status === "noPath") {
        recover("no_path", "no path to moving player");
      }
    };

    const monitor = setInterval(() => {
      if (settled) return;
      const now = Date.now();
      const entity = resolveEntity();
      if (!entity) {
        if (missingSince === undefined) {
          missingSince = now;
          try {
            bot.pathfinder.setGoal(null);
          } catch {
            // best effort
          }
        } else if (now - missingSince >= 10_000) {
          const profile = RECOVERY_PROFILES[profileIndex]!.name;
          finish(new PathfindingFailure(
            "follow target was unavailable or outside render range for 10 seconds",
            "target_unavailable",
            recoveries + 1,
            profile,
            "target entity unavailable",
          ));
        }
        return;
      }

      missingSince = undefined;
      if (entity !== currentEntity || bot.pathfinder.goal === null) {
        bindGoal(entity);
        return;
      }

      const position = bot.entity?.position;
      const distance = distanceBetween(position, entity.position);
      const moved = distanceBetween(position, lastPosition);
      if (moved >= 0.75 || distance + 0.75 < lastDistance) {
        lastProgressAt = now;
        lastPosition = clonePosition(position);
        lastDistance = distance;
      } else if (
        distance > range + 1.5 &&
        now - lastProgressAt >= 8_000
      ) {
        recover("stalled", "bot position did not progress for 8 seconds");
      }
    }, 1_000);

    signal.addEventListener("abort", onAbort, { once: true });
    bot.on("path_update", onPathUpdate);
    const initial = resolveEntity();
    if (initial) {
      bindGoal(initial);
    } else {
      missingSince = Date.now();
    }
  });
}

export function pathfindingFailureDetails(err: unknown): Record<string, unknown> {
  if (err instanceof PathfindingFailure) {
    return {
      failureKind: err.kind,
      attempts: err.attempts,
      profile: err.profile,
      causeMessage: err.causeMessage,
    };
  }
  return {
    failureKind: classifyPathFailure(errorMessage(err)),
    causeMessage: errorMessage(err),
  };
}

function gotoWithAbort(
  bot: Bot,
  goal: goalsNS.Goal,
  signal: AbortSignal,
): Promise<void> {
  const gotoPromise = bot.pathfinder.goto(goal);
  let onAbort: (() => void) | undefined;
  const abortPromise = new Promise<never>((_resolve, reject) => {
    onAbort = () => {
      try {
        bot.pathfinder.setGoal(null);
      } catch {
        // best effort
      }
      reject(new Error("aborted"));
    };
    signal.addEventListener("abort", onAbort, { once: true });
  });
  return Promise.race([gotoPromise, abortPromise]).finally(() => {
    if (onAbort) signal.removeEventListener("abort", onAbort);
  });
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

function classifyPathFailure(message: string): PathFailureKind {
  const lower = message.toLowerCase();
  if (lower.includes("timeout") || lower.includes("too long") || lower.includes("to long")) return "timeout";
  if (lower.includes("no path")) return "no_path";
  if (lower.includes("goal") && lower.includes("changed")) return "goal_changed";
  if (lower.includes("stopped") || lower.includes("path_stop")) return "stopped";
  if (lower.includes("target") && lower.includes("unavailable")) return "target_unavailable";
  if (lower.includes("stalled") || lower.includes("progress")) return "stalled";
  return "unknown";
}

function isRetryablePathFailure(kind: PathFailureKind): boolean {
  return kind === "timeout" || kind === "no_path" || kind === "unknown";
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function clonePosition(position: Vec3 | undefined): Vec3 | undefined {
  return position?.clone();
}

function distanceBetween(
  a: { x: number; y: number; z: number } | undefined,
  b: { x: number; y: number; z: number } | undefined,
): number {
  if (!a || !b) return Number.POSITIVE_INFINITY;
  const dx = a.x - b.x;
  const dy = a.y - b.y;
  const dz = a.z - b.z;
  return Math.sqrt(dx * dx + dy * dy + dz * dz);
}

export { goals };
export type { Vec3 };
