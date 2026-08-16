import type { Bot } from "mineflayer";

/**
 * Each pattern's regex must capture: group 1 = username, group 2 = message.
 *
 * Username class is restricted to MC-valid characters and bounded length (3-16)
 * so the patterns do not match server/system prefixes like "[Server]: ..." or
 * "Console: ...". The leading `[rank]` is allowed but optional in some variants.
 *
 * Patterns are ordered most-specific to least-specific. mineflayer's chat parser
 * tries them in registration order and stops on the first match, so this ordering
 * matters: we want "[rank] <player> msg" to win over a bare colon-style match.
 */
export interface ChatPattern {
  regex: RegExp;
  kind: "chat" | "whisper";
  description: string;
}

// MC usernames: 3-16 chars of [A-Za-z0-9_]. Some servers/plugins allow shorter
// "names" for NPC entities; we keep the conservative 3-16 cap since real chat
// always involves a real player name.
const MC_NAME = "[A-Za-z0-9_]{3,16}";
// Rank/group bracket content: letters, digits, underscore, hyphen, plus.
const RANK_BRACKET = "\\[[A-Za-z0-9_+\\-]+\\]";
// Some networks decorate chat lines before the rank (for example
// "▎ [Admin] xxdj » hello"). Mineflayer strips colors but preserves those
// printable channel glyphs, so allow a non-name decoration before `[rank]`.
const CHAT_DECORATION = "(?:[^A-Za-z0-9_<\\[]+\\s*)?";

// Known server pseudo-names that should never be treated as player chat.
// Used as a negative lookahead in bare-separator patterns which are otherwise
// ambiguous (Console, Server, Rcon, etc. are not real player usernames).
const RESERVED_NAMES = "(?:Console|Server|Rcon|System|Admin)";

export const PATTERNS: ChatPattern[] = [
  {
    regex: new RegExp(`^${CHAT_DECORATION}${RANK_BRACKET}\\s+<(${MC_NAME})>\\s+(.+)$`),
    kind: "chat",
    description: "[rank] <player> message",
  },
  {
    regex: new RegExp(`^<(${MC_NAME})>\\s+(.+)$`),
    kind: "chat",
    description: "<player> message (vanilla)",
  },
  {
    regex: new RegExp(`^${CHAT_DECORATION}${RANK_BRACKET}\\s+(${MC_NAME})\\s+[»›>]\\s+(.+)$`),
    kind: "chat",
    description: "[rank] player » message",
  },
  {
    regex: new RegExp(`^(?!${RESERVED_NAMES}\\s)(${MC_NAME})\\s+[»›>]\\s+(.+)$`),
    kind: "chat",
    description: "player » message",
  },
  {
    regex: new RegExp(`^${CHAT_DECORATION}${RANK_BRACKET}\\s+(${MC_NAME}):\\s+(.+)$`),
    kind: "chat",
    description: "[rank] player: message",
  },
  {
    regex: new RegExp(`^(?!${RESERVED_NAMES}:)(${MC_NAME}):\\s+(.+)$`),
    kind: "chat",
    description: "player: message (bare colon)",
  },
];

/**
 * Whisper patterns for Essentials and similar plugins. Format: `[X -> Y] message`
 * where the LEFT side of the arrow is the sender. The bot's perspective:
 *   `[player -> me] msg`  → inbound whisper from `player` (we want this).
 *   `[me -> player] msg`  → outbound echo of the bot's own whisper (IGNORE).
 *
 * We ONLY register inbound patterns here. Mineflayer's built-in
 * `^[X -> Y] msg` whisper pattern catches outbound echoes too, but it correctly
 * captures group 1 = the LEFT name (which is "me" for outbound), and the chat
 * surface filter drops `from === "me"`. We must NOT register a pattern that
 * captures the RIGHT name (the recipient) — that produced a feedback loop where
 * the bot processed its own outbound messages as if the owner sent them.
 *
 * The first capture group is the sender; the second is the message.
 * Nicknames may have a leading `~` (Essentials nickname marker) or a rank
 * prefix like `[VIP]` before the actual MC name. Each pattern requires the
 * RIGHT side to be literal `me` to be sure we're not matching outbound echoes.
 */
export const WHISPER_PATTERNS: ChatPattern[] = [
  {
    // vanilla: "xxdj whispers to you: hi"  (or "xxdj whispers: hi" on older servers)
    regex: new RegExp(`^(${MC_NAME}) whispers(?: to you)?:?\\s+(.+)$`),
    kind: "whisper",
    description: "vanilla whisper (X whispers to you: msg)",
  },
  {
    // [<rank> name -> me] msg     e.g. "[VIP xxdj -> me] hi"
    regex: new RegExp(`^\\[[A-Za-z0-9_+\\-]+\\s+~?(${MC_NAME})\\s*->\\s*me\\]\\s*(.+)$`),
    kind: "whisper",
    description: "[rank name -> me] message (essentials inbound)",
  },
  {
    // [~name -> me] msg     e.g. "[~xxdj -> me] hi"
    regex: new RegExp(`^\\[~?(${MC_NAME})\\s*->\\s*me\\]\\s*(.+)$`),
    kind: "whisper",
    description: "[name -> me] message (essentials inbound)",
  },
];

/**
 * Pure parser used by tests. Mirrors what mineflayer's chatAddPattern wiring does
 * at runtime: tries each pattern in order, returns the first match.
 */
export function parseChatLine(line: string): { kind: "chat"; from: string; text: string } | null {
  for (const p of PATTERNS) {
    const m = line.match(p.regex);
    if (m) {
      return { kind: "chat", from: m[1]!, text: m[2]! };
    }
  }
  return null;
}

/** Pure parser for whisper patterns, for unit-testing. */
export function parseWhisperLine(line: string): { kind: "whisper"; from: string; text: string } | null {
  for (const p of WHISPER_PATTERNS) {
    const m = line.match(p.regex);
    if (m) {
      return { kind: "whisper", from: m[1]!, text: m[2]! };
    }
  }
  return null;
}

/**
 * Register every chat and whisper pattern with mineflayer. Each chat match fires
 * the standard `chat` event; each whisper match fires the standard `whisper`
 * event — the existing `wireBotEvents` handler in src/bot/events.ts picks both
 * up unchanged. The chat surface separately drops from="me"/"you" to filter
 * outbound whisper echoes.
 *
 * Safe to call once per bot, after `inject_allowed` fires.
 */
export function registerChatPatterns(bot: Bot): void {
  for (const p of [...PATTERNS, ...WHISPER_PATTERNS]) {
    bot.chatAddPattern(p.regex, p.kind, p.description);
  }
}
