import type { Bot } from "mineflayer";
import type { Entity } from "prismarine-entity";
import { z } from "zod";
import {
  normalizeMinecraftUsername,
  resolveOnlinePlayer,
} from "../../bot/playerIdentity.js";

export const MAX_ENTITY_SELECTOR_RADIUS = 32;
const DISTANCE_TIE_EPSILON = 0.000_001;

/**
 * A stable, bounded entity reference. Exactly one selector is accepted: an
 * observed entity ID, a player username, or a canonical entity type near us.
 */
export const entityIdSelectorSchema = z.object({
  entityId: z.number().int().nonnegative().describe("Entity ID returned by a recent inspection."),
}).strict();

export const playerUsernameSelectorSchema = z.object({
  username: z.string().trim().min(1).max(64).describe("Exact online Minecraft player username."),
}).strict();

export const entityTypeSelectorSchema = z.object({
  entityType: z.string().trim().min(1).max(64).describe("Exact canonical entity type, such as zombie."),
  radius: z.number().finite().min(1).max(MAX_ENTITY_SELECTOR_RADIUS).describe(
    "Maximum loaded-entity search radius in blocks.",
  ),
}).strict();

export const entitySelectorSchema = z.union([
  entityIdSelectorSchema,
  playerUsernameSelectorSchema,
  entityTypeSelectorSchema,
]);

export type EntitySelector = z.infer<typeof entitySelectorSchema>;

/** Bounded, serializable entity data safe to return from a skill. */
export interface EntityTarget {
  readonly id: number;
  /** Mineflayer's canonical entity name, such as `zombie` or `player`. */
  readonly name: string;
  /** Mineflayer's broad entity kind, such as `mob` or `player`. */
  readonly type: string;
  readonly position: Readonly<{ x: number; y: number; z: number }>;
  readonly distance: number;
  /** Present only for a resolved player entity. */
  readonly username?: string;
}

export interface EntitySelectorSuccess {
  readonly ok: true;
  /** Live object for the immediate Mineflayer call; never return it to users. */
  readonly entity: Entity;
  readonly target: EntityTarget;
}

export interface EntitySelectorFailure {
  readonly ok: false;
  readonly code: "TARGET_UNAVAILABLE" | "WORLD_UNAVAILABLE";
  readonly summary: string;
  readonly recoverable: boolean;
  readonly details: Record<string, unknown>;
}

export type EntitySelectorResult = EntitySelectorSuccess | EntitySelectorFailure;

type EntitySelectorBot = Pick<Bot, "entities" | "players"> & {
  entity?: Pick<Entity, "id" | "position">;
};

/**
 * Resolve a selector immediately before an interaction. Type searches are
 * deliberately deterministic only when there is one nearest entity; a tied
 * closest pair is an actionable ambiguity, not an iteration-order choice.
 */
export function resolveEntitySelector(
  bot: EntitySelectorBot,
  selector: EntitySelector,
): EntitySelectorResult {
  const origin = bot.entity?.position;
  if (!origin) {
    return unavailable("cannot resolve an entity before the bot has spawned", { selector: publicSelector(selector) }, false, "WORLD_UNAVAILABLE");
  }

  if ("entityId" in selector) {
    const matches = liveEntities(bot).filter((entity) => entity.id === selector.entityId);
    if (matches.length !== 1) {
      return unavailable(
        matches.length > 1
          ? `entity ID ${selector.entityId} is ambiguous`
          : `entity ID ${selector.entityId} is no longer available`,
        { selector: publicSelector(selector), matches: matches.map((entity) => sanitizeEntity(entity, origin)) },
      );
    }
    return success(matches[0]!, origin);
  }

  if ("username" in selector) {
    const normalizedUsername = normalizeMinecraftUsername(selector.username);
    const matchingPlayers = Object.entries(bot.players).filter(([key, player]) =>
      normalizeMinecraftUsername(key) === normalizedUsername ||
      normalizeMinecraftUsername(player.username ?? "") === normalizedUsername,
    );
    const matchingEntityIds = new Set(matchingPlayers
      .map(([, player]) => player.entity?.id)
      .filter((id): id is number => typeof id === "number"));
    if (matchingEntityIds.size > 1) {
      return unavailable(`player username '${selector.username}' is ambiguous`, {
        selector: publicSelector(selector),
        username: selector.username,
        reason: "ambiguous",
      });
    }
    const player = resolveOnlinePlayer(bot, selector.username);
    const playerEntity = player?.player.entity;
    if (!player || !playerEntity) {
      return unavailable(`player '${selector.username}' is not available in render range`, {
        selector: publicSelector(selector),
        reason: "offline_or_outside_render_range",
      });
    }
    const current = liveEntities(bot).filter((entity) => entity.id === playerEntity.id);
    if (current.length !== 1) {
      return unavailable(`player '${player.username}' is no longer available in render range`, {
        selector: publicSelector(selector),
        username: player.username,
        reason: current.length > 1 ? "ambiguous" : "stale_entity",
      });
    }
    return success(current[0]!, origin, player.username);
  }

  const expectedType = normalizeType(selector.entityType);
  const candidates = liveEntities(bot)
    .filter((entity) => normalizeType(entity.name) === expectedType)
    .map((entity) => ({ entity, distance: distance(origin, entity.position) }))
    .filter((candidate) => candidate.distance <= selector.radius);
  if (candidates.length === 0) {
    return unavailable(`no ${expectedType} is available within ${selector.radius} blocks`, {
      selector: publicSelector(selector),
      entityType: expectedType,
      radius: selector.radius,
    });
  }

  const nearestDistance = Math.min(...candidates.map((candidate) => candidate.distance));
  const nearest = candidates.filter((candidate) =>
    Math.abs(candidate.distance - nearestDistance) <= DISTANCE_TIE_EPSILON,
  );
  if (nearest.length !== 1) {
    return unavailable(`multiple ${expectedType} entities are equally near; choose a specific entity ID`, {
      selector: publicSelector(selector),
      entityType: expectedType,
      radius: selector.radius,
      candidates: nearest.slice(0, 8).map((candidate) => sanitizeEntity(candidate.entity, origin)),
      reason: "ambiguous",
    });
  }
  return success(nearest[0]!.entity, origin);
}

/** Whether a live entity is still a valid immediate target. */
export function isLiveEntity(
  bot: Pick<Bot, "entities">,
  entityId: number,
): boolean {
  return getLiveEntity(bot, entityId) !== undefined;
}

/** Return the currently tracked live entity for an already-resolved ID. */
export function getLiveEntity(
  bot: Pick<Bot, "entities">,
  entityId: number,
): Entity | undefined {
  const entity = bot.entities[entityId];
  return Number.isSafeInteger(entityId) && entity && entity.id === entityId &&
    Number.isSafeInteger(entity.id) && entity.isValid !== false && hasFinitePosition(entity)
    ? entity
    : undefined;
}

function success(
  entity: Entity,
  origin: { x: number; y: number; z: number },
  username?: string,
): EntitySelectorSuccess {
  return {
    ok: true,
    entity,
    target: sanitizeEntity(entity, origin, username),
  };
}

function liveEntities(bot: EntitySelectorBot): Entity[] {
  const selfId = bot.entity?.id;
  const unique = new Set<Entity>();
  for (const entity of Object.values(bot.entities)) {
    if (!entity || !Number.isSafeInteger(entity.id) || entity.id === selfId ||
        entity.isValid === false || !hasFinitePosition(entity)) continue;
    unique.add(entity);
  }
  return [...unique];
}

function sanitizeEntity(
  entity: Entity,
  origin: { x: number; y: number; z: number },
  username?: string,
): EntityTarget {
  const name = boundedText(entity.name, "unknown");
  const type = boundedText(entity.type, "unknown");
  const resolvedUsername = username ?? (typeof entity.username === "string" ? entity.username : undefined);
  return Object.freeze({
    id: entity.id,
    name,
    type,
    position: Object.freeze({
      x: roundCoordinate(entity.position.x),
      y: roundCoordinate(entity.position.y),
      z: roundCoordinate(entity.position.z),
    }),
    distance: roundCoordinate(distance(origin, entity.position)),
    ...(resolvedUsername ? { username: boundedText(resolvedUsername, "") } : {}),
  });
}

function publicSelector(selector: EntitySelector): Record<string, unknown> {
  if ("entityId" in selector) return { entityId: selector.entityId };
  if ("username" in selector) return { username: selector.username };
  return { entityType: normalizeType(selector.entityType), radius: selector.radius };
}

function unavailable(
  summary: string,
  details: Record<string, unknown>,
  recoverable = true,
  code: EntitySelectorFailure["code"] = "TARGET_UNAVAILABLE",
): EntitySelectorFailure {
  return { ok: false, code, summary, recoverable, details };
}

function normalizeType(value: unknown): string {
  return typeof value === "string" ? value.trim().toLowerCase() : "";
}

function boundedText(value: unknown, fallback: string): string {
  return typeof value === "string" && value.length > 0 ? value.slice(0, 64) : fallback;
}

function hasFinitePosition(entity: Pick<Entity, "position">): boolean {
  const position = entity.position;
  return Boolean(position) && [position.x, position.y, position.z].every(Number.isFinite);
}

function distance(
  first: { x: number; y: number; z: number },
  second: { x: number; y: number; z: number },
): number {
  const x = first.x - second.x;
  const y = first.y - second.y;
  const z = first.z - second.z;
  return Math.sqrt(x * x + y * y + z * z);
}

function roundCoordinate(value: number): number {
  return Math.round(value * 1_000) / 1_000;
}
