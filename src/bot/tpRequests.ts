import type { Bot } from "mineflayer";
import type { Logger } from "../util/logger.js";
import { isOwner } from "../permissions/index.js";

// Each regex captures the requester's username as group 1.
// Patterns are conservative — MC username class to avoid catching "Console", "Server", etc.
const TPA_PATTERNS: RegExp[] = [
  // Vanilla / Essentials: "xxdj has requested to teleport to you"
  /^([A-Za-z0-9_]{3,16}) has requested to teleport to you/,
  // Essentials variants: "xxdj has requested that you teleport to them"
  /^([A-Za-z0-9_]{3,16}) has requested that you teleport to them/,
  // "[TPA] xxdj wants to teleport to you"
  /^\[TPA\]\s+([A-Za-z0-9_]{3,16}) wants to teleport to you/,
  // EssentialsX: "xxdj is requesting to teleport to your location"
  /^([A-Za-z0-9_]{3,16}) is requesting to teleport/,
];

export interface TpRequestDeps {
  bot: Bot;
  log: Logger;
  ownerUsername: string;
  runCommand: (cmd: string) => void;
}

/**
 * Parses a raw message line and returns the TPA requester username if any
 * pattern matches. Exported for unit-testing the patterns without a live bot.
 */
export function parseTpRequester(line: string): string | null {
  for (const p of TPA_PATTERNS) {
    const m = line.match(p);
    if (m) return m[1] ?? null;
  }
  return null;
}

/**
 * Wire mineflayer's `messagestr` event so that incoming TPA requests from the
 * owner trigger an automatic /tpaccept.
 */
export function wireTpAutoAccept(deps: TpRequestDeps): void {
  deps.bot.on("messagestr", (line: string) => {
    const requester = parseTpRequester(line);
    if (!requester) return;
    if (!isOwner(requester, deps.ownerUsername)) {
      deps.log.info({ requester }, "ignoring TPA request from non-owner");
      return;
    }
    deps.log.info({ requester }, "auto-accepting TPA request from owner");
    deps.runCommand("tpaccept");
  });
}
