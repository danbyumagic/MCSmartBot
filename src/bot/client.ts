import { join } from "node:path";
import { mkdirSync } from "node:fs";
import { createBot, type Bot } from "mineflayer";
import type { Config } from "../config.js";
import type { Logger } from "../util/logger.js";
import type { MicrosoftAuthPrompt } from "../app/contracts.js";
import { registerChatPatterns } from "./chatPatterns.js";
import { ensureCollectBlock } from "../skills/collectblock.js";
import { installMineflayerProtocolCompatibility } from "./clientTickEnd.js";

export interface BotHandle {
  bot: Bot;
  disconnect: (reason?: string) => void;
}

export function createBotClient(
  cfg: Config,
  log: Logger,
  options: { onMicrosoftAuth?: (prompt: MicrosoftAuthPrompt) => void } = {},
): BotHandle {
  log.info(
    {
      host: cfg.serverHost,
      port: cfg.serverPort,
      version: cfg.serverVersion,
      username: cfg.botUsername,
      auth: cfg.botAuth,
    },
    "connecting to server",
  );

  // For Microsoft (online) auth, mineflayer caches OAuth tokens in `profilesFolder`.
  // Pinning it under data/ keeps it next to the SQLite DB and out of the user's
  // global ~/.minecraft cache. First run triggers a device-code flow logged via
  // onMsaCode below; subsequent runs reuse the refresh token silently.
  const profilesFolder = join(cfg.dataDir, "auth");
  if (cfg.botAuth === "microsoft") {
    mkdirSync(profilesFolder, { recursive: true });
  }

  const bot = createBot({
    host: cfg.serverHost,
    port: cfg.serverPort,
    username: cfg.botUsername,
    auth: cfg.botAuth,
    version: cfg.serverVersion,
    // Disable mineflayer's built-in chat/whisper patterns. They overlap with our
    // custom patterns in src/bot/chatPatterns.ts and cause every inbound message
    // to fire two events, doubling agent responses. Our patterns cover vanilla
    // and Essentials formats and reject server pseudo-names like "Server"/"Console"
    // which mineflayer's defaults would happily classify as chat.
    defaultChatPatterns: false,
    ...(cfg.botAuth === "microsoft"
      ? {
          profilesFolder,
          onMsaCode: (data) => {
            options.onMicrosoftAuth?.({
              verificationUri: data.verification_uri,
              userCode: data.user_code,
              expiresAt: Date.now() + (data.expires_in ?? 900) * 1_000,
            });
            log.warn(
              {
                verification_uri: data.verification_uri,
                user_code: data.user_code,
                expires_in_seconds: data.expires_in,
              },
              "Microsoft device-code auth required — visit the URL and enter the code",
            );
            // Also print to stdout in case logs are being filtered.
            process.stdout.write(
              `\n[ AUTH ] Open ${data.verification_uri} and enter code: ${data.user_code}\n` +
                `         (expires in ${Math.floor(data.expires_in / 60)} minutes)\n\n`,
            );
          },
        }
      : {}),
  });

  // Minecraft 1.21.2+ batches interaction packets until the client's tick-end
  // marker. This is a no-op on older protocols and suppresses itself when a
  // future Mineflayer release sends the marker natively.
  const removeProtocolCompatibility = installMineflayerProtocolCompatibility(bot);
  bot.once("end", removeProtocolCompatibility);

  bot.on("error", (err) => log.error({ err }, "mineflayer error"));

  // mineflayer queues plugins in createBot but only injects them when
  // `inject_allowed` fires on the next tick. bot.chatAddPattern doesn't exist
  // until then, so defer registration to that event.
  bot.once("inject_allowed", () => {
    registerChatPatterns(bot);
    ensureCollectBlock(bot);
  });

  return {
    bot,
    disconnect: (reason = "shutdown") => {
      try {
        bot.quit(reason);
      } catch (err) {
        log.warn({ err }, "error during bot.quit");
      }
    },
  };
}
