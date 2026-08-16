import type { Bot } from "mineflayer";
import type { Bus } from "../bus/index.js";
import type { Logger } from "../util/logger.js";
import { sameMinecraftUsername } from "./playerIdentity.js";

export function wireBotEvents(bot: Bot, bus: Bus, log: Logger, _ownerUsername: string): void {
  let hasSpawned = false;
  bot.on("spawn", () => {
    const respawn = hasSpawned;
    hasSpawned = true;
    log.info({ respawn }, "bot spawned");
    bus.emit("bot.ready", undefined);
    if (respawn) {
      bus.emit("agent.trigger", { kind: "botRespawn" });
    } else {
      bus.emit("world.event", {
        type: "bot_connected",
        severity: "info",
        summary: "bot connected and spawned",
      });
    }
  });

  bot.on("death", () => {
    log.warn("bot died");
    bus.emit("agent.trigger", { kind: "botDeath" });
  });

  bot.on("end", (reason) => {
    log.warn({ reason }, "bot connection ended");
    bus.emit("world.event", {
      type: "connection_end",
      severity: "warning",
      summary: `bot connection ended: ${String(reason ?? "unknown")}`,
      details: { reason: String(reason ?? "unknown") },
    });
    bus.emit("bot.end", { reason: String(reason ?? "unknown") });
  });

  bot.on("kicked", (reason, loggedIn) => {
    const formatted = formatKickReason(reason);
    log.warn({ reason: formatted, loggedIn }, "bot kicked by server");
    bus.emit("world.event", {
      type: "bot_kicked",
      severity: "warning",
      summary: `bot kicked by server: ${formatted}`,
      details: { reason: formatted, loggedIn },
    });
  });

  bot.on("playerJoined", (player) => {
    if (!player.username || sameMinecraftUsername(player.username, bot.username)) return;
    bus.emit("world.event", {
      type: "player_join",
      severity: "info",
      summary: `${player.username} joined the server`,
      details: { username: player.username },
    });
  });

  bot.on("playerLeft", (player) => {
    if (!player.username || sameMinecraftUsername(player.username, bot.username)) return;
    bus.emit("world.event", {
      type: "player_leave",
      severity: "info",
      summary: `${player.username} left the server`,
      details: { username: player.username },
    });
  });

  bot.on("chat", (username, message) => {
    if (sameMinecraftUsername(username, bot.username)) return; // ignore self
    log.debug({ username, message }, "public chat");
    bus.emit("chat", { from: username, text: message, whisper: false });
  });

  bot.on("whisper", (username, message) => {
    if (sameMinecraftUsername(username, bot.username)) return;
    log.debug({ username, message }, "whisper");
    bus.emit("chat", { from: username, text: message, whisper: true });
  });
}

function formatKickReason(reason: unknown): string {
  if (typeof reason === "string") {
    try {
      return JSON.stringify(JSON.parse(reason));
    } catch {
      return reason;
    }
  }
  try {
    return JSON.stringify(reason);
  } catch {
    return String(reason);
  }
}
