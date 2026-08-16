import type { Bus } from "../bus/index.js";
import type { DB } from "../memory/db.js";
import { appendConversation } from "../memory/conversations.js";
import { isOwner } from "../permissions/index.js";
import type { AssignableRole } from "../permissions/roles.js";
import type { Logger } from "../util/logger.js";

export interface ChatSurfaceDeps {
  bus: Bus;
  db: DB;
  log: Logger;
  ownerUsername: string;
  /** Filter self-echoes that bypass events.ts (e.g. plugin-prefixed echoes). Accepts a string or a getter invoked per event. */
  botUsername: string | (() => string);
  whisperTo: (user: string, text: string) => void;
  /** Resolve non-owner access. Undefined means the player is not authorized. */
  roleFor?: (username: string) => AssignableRole | undefined;
  /** Owner-only emergency control that bypasses the agent queue. */
  onForceStop?: (source: { from: string; whisper: boolean }) => void;
}

const BOT_PREFIX_RE = /^bot[,\s]\s*/i;
const BOT_WORD_RE = /\bbot\b/i;

export function wireChatSurface(deps: ChatSurfaceDeps): void {
  const { bus, db, log, ownerUsername, whisperTo } = deps;

  bus.on("chat", (e) => {
    // Drop server self-echoes of the bot's outbound whispers.
    // Mineflayer parses "[me -> xxdj] ..." echoes with from="me" (or "you" for the
    // reverse direction). These are never real MC usernames (min 3 chars, and
    // "me"/"you" are server-reserved aliases). Filtering here prevents the bot
    // from treating its own sent messages as inbound owner commands.
    const fromLower = e.from.toLowerCase();
    const botName = typeof deps.botUsername === "function" ? deps.botUsername() : deps.botUsername;
    if (fromLower === "me" || fromLower === "you" || fromLower === botName.toLowerCase()) {
      log.debug({ from: e.from, text: e.text }, "ignoring server self-echo of bot's outbound message");
      return;
    }

    // Record everything for context.
    appendConversation(db, { speaker: e.from, text: e.text, channel: "chat" });

    const owner = isOwner(e.from, ownerUsername);
    const role = owner ? "owner" : deps.roleFor?.(e.from);
    const authorized = role !== undefined;

    if (owner && /^\/stop\s*$/i.test(e.text.trim())) {
      deps.onForceStop?.({ from: e.from, whisper: e.whisper });
      return;
    }

    if (e.whisper) {
      if (authorized) {
        bus.emit("agent.trigger", { kind: "chat", from: e.from, text: e.text });
      } else {
        // Silently ignore unauthorized whispers so the bot does not advertise
        // its presence or access model to random players.
        log.debug({ from: e.from }, "ignoring non-owner whisper");
      }
      return;
    }

    // Public chat: only authorized players can reach the agent. The owner is
    // always treated as addressing the bot; this lets rank-prefixed server chat
    // such as "[Admin] xxdj » hello" work naturally without requiring "bot".
    if (!authorized) return;
    // Two ways an authorized player can address the bot in public:
    //   1. Leading "bot," / "bot " prefix (legacy explicit command).
    //   2. Anywhere in the message: "bot" as a standalone word, or the bot's
    //      in-game username as a substring (case-insensitive).
    // If neither applies, the message is conversational/incidental and goes
    // into context (already appended above) but doesn't wake Claude.
    const prefixMatch = e.text.match(BOT_PREFIX_RE);
    const stripped = prefixMatch ? e.text.slice(prefixMatch[0].length) : e.text;
    if (stripped.length === 0) return;
    const lower = e.text.toLowerCase();
    const botNameLower = botName.toLowerCase();
    const addressesBot =
      prefixMatch !== null ||
      BOT_WORD_RE.test(e.text) ||
      (botNameLower.length >= 3 && lower.includes(botNameLower));
    if (!owner && !addressesBot) return;
    bus.emit("agent.trigger", { kind: "chat", from: e.from, text: stripped });
  });
}
