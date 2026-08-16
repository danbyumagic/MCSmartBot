import type { Bot, Player } from "mineflayer";

export interface ResolvedPlayer {
  requestedUsername: string;
  username: string;
  player: Player;
}

export function normalizeMinecraftUsername(username: string): string {
  return username.trim().toLowerCase();
}

export function sameMinecraftUsername(a: string, b: string): boolean {
  const normalizedA = normalizeMinecraftUsername(a);
  return normalizedA.length > 0 && normalizedA === normalizeMinecraftUsername(b);
}

/**
 * Resolve a player using Minecraft's case-insensitive username semantics.
 * Mineflayer's `bot.players` object is keyed by server-provided casing, so a
 * direct property lookup alone is not reliable on proxy/plugin chat surfaces.
 */
export function resolveOnlinePlayer(
  bot: Pick<Bot, "players">,
  requestedUsername: string,
): ResolvedPlayer | undefined {
  const trimmed = requestedUsername.trim();
  const exact = bot.players[trimmed];
  if (exact) {
    return {
      requestedUsername,
      username: exact.username || trimmed,
      player: exact,
    };
  }

  const normalized = normalizeMinecraftUsername(trimmed);
  if (!normalized) return undefined;
  for (const [key, player] of Object.entries(bot.players)) {
    if (
      normalizeMinecraftUsername(key) === normalized ||
      normalizeMinecraftUsername(player.username ?? "") === normalized
    ) {
      return {
        requestedUsername,
        username: player.username || key,
        player,
      };
    }
  }
  return undefined;
}
