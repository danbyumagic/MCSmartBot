import type { Bot } from "mineflayer";

export interface ChatMirrorDeps {
  bot: Bot;
  /** Sink for each line. Defaults to writing to process.stdout. */
  write?: (line: string) => void;
}

/**
 * Subscribe to mineflayer's `messagestr` event and mirror every chat-stream
 * line to the operator's terminal. This captures public chat, whispers,
 * system messages, TPA notifications, join/leave, death messages — everything
 * the bot sees.
 *
 * Output is verbatim — no prefix or timestamp — so the operator sees what
 * appears in-game.
 */
export function wireChatMirror(deps: ChatMirrorDeps): void {
  const write = deps.write ?? ((line: string) => process.stdout.write(line + "\n"));
  deps.bot.on("messagestr", (text: string) => {
    if (!text || text.length === 0) return;
    write(text);
  });
}
