import { EventEmitter } from "node:events";
import { describe, expect, it } from "vitest";
import { createBus } from "../../src/bus/index.js";
import { wireBotEvents } from "../../src/bot/events.js";
import { createLogger } from "../../src/util/logger.js";

describe("wireBotEvents lifecycle", () => {
  it("emits death and distinguishes initial spawn from respawn", () => {
    const bot = Object.assign(new EventEmitter(), { username: "SmartBot" });
    const bus = createBus();
    const triggers: string[] = [];
    let ready = 0;
    bus.on("agent.trigger", (trigger) => triggers.push(trigger.kind));
    bus.on("bot.ready", () => { ready++; });
    wireBotEvents(
      bot as never,
      bus,
      createLogger({ level: "error" }),
      "alice",
    );
    bot.emit("spawn");
    bot.emit("death");
    bot.emit("spawn");
    expect(ready).toBe(2);
    expect(triggers).toEqual(["botDeath", "botRespawn"]);
  });

  it("emits player presence and connection events", () => {
    const bot = Object.assign(new EventEmitter(), { username: "SmartBot" });
    const bus = createBus();
    const events: string[] = [];
    bus.on("world.event", (event) => events.push(event.type));
    wireBotEvents(
      bot as never,
      bus,
      createLogger({ level: "error" }),
      "alice",
    );
    bot.emit("spawn");
    bot.emit("playerJoined", { username: "bob" });
    bot.emit("playerLeft", { username: "bob" });
    bot.emit("playerJoined", { username: "SmartBot" });
    bot.emit("end", "socket closed");
    expect(events).toEqual([
      "bot_connected",
      "player_join",
      "player_leave",
      "connection_end",
    ]);
  });

  it("records the server kick reason for login diagnostics", () => {
    const bot = Object.assign(new EventEmitter(), { username: "SmartBot" });
    const bus = createBus();
    const events: Array<{ type: string; summary: string }> = [];
    bus.on("world.event", (event) => events.push(event));
    wireBotEvents(
      bot as never,
      bus,
      createLogger({ level: "error" }),
      "02DJ",
    );
    bot.emit("kicked", '{"text":"Outdated client"}', false);
    expect(events).toMatchObject([{
      type: "bot_kicked",
      summary: expect.stringContaining("Outdated client"),
    }]);
  });
});
