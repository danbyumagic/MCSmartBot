import { EventEmitter } from "node:events";
import { describe, expect, it, vi } from "vitest";
import {
  installMineflayerProtocolCompatibility,
  type ClientTickEndBot,
} from "../../src/bot/clientTickEnd.js";

function fakeBot(required: boolean, protocolVersion = 769) {
  const events = new EventEmitter();
  const write = vi.fn();
  const bot: ClientTickEndBot = {
    protocolVersion,
    supportFeature: vi.fn(() => required),
    on: (event, listener) => events.on(event, listener),
    removeListener: (event, listener) => events.removeListener(event, listener),
    _client: { state: "play", write },
  };
  return { bot, events, write };
}

describe("Mineflayer modern protocol compatibility", () => {
  it("emits one tick_end after a modern physics tick", async () => {
    const { bot, events, write } = fakeBot(true);
    const teardown = installMineflayerProtocolCompatibility(bot);

    events.emit("physicsTick");
    await Promise.resolve();

    expect(write).toHaveBeenCalledWith("tick_end", {});
    expect(write).toHaveBeenCalledTimes(1);
    teardown();
  });

  it("does not duplicate a packet emitted natively later in the same tick", async () => {
    const { bot, events, write } = fakeBot(true);
    installMineflayerProtocolCompatibility(bot);

    events.emit("physicsTick");
    bot._client.write("tick_end", {});
    await Promise.resolve();

    expect(write).toHaveBeenCalledTimes(1);
  });

  it("is a no-op on protocols that do not require tick_end", async () => {
    const { bot, events, write } = fakeBot(false, 758);
    installMineflayerProtocolCompatibility(bot);

    events.emit("physicsTick");
    await Promise.resolve();

    expect(write).not.toHaveBeenCalled();
  });

  it("installs once and restores the original writer on teardown", async () => {
    const { bot, events, write } = fakeBot(true);
    const originalWrite = bot._client.write;
    const first = installMineflayerProtocolCompatibility(bot);
    const second = installMineflayerProtocolCompatibility(bot);
    expect(second).toBe(first);

    first();
    expect(bot._client.write).toBe(originalWrite);
    events.emit("physicsTick");
    await Promise.resolve();
    expect(write).not.toHaveBeenCalled();
  });

  it("replaces Mineflayer's zero/omitted modern interaction sequences with one shared counter", () => {
    const { bot, write } = fakeBot(false);
    const teardown = installMineflayerProtocolCompatibility(bot);

    bot._client.write("block_place", { sequence: 0, hand: 0 });
    bot._client.write("use_item", { sequence: 1, hand: 0 });
    bot._client.write("block_dig", { status: 0 });

    expect(write).toHaveBeenNthCalledWith(1, "block_place", { sequence: 1, hand: 0 });
    expect(write).toHaveBeenNthCalledWith(2, "use_item", { sequence: 2, hand: 0 });
    expect(write).toHaveBeenNthCalledWith(3, "block_dig", { status: 0, sequence: 3 });
    teardown();
  });

  it("leaves interaction payloads unchanged before the sequence protocol", () => {
    const { bot, write } = fakeBot(false, 758);
    installMineflayerProtocolCompatibility(bot);

    bot._client.write("block_place", { hand: 0 });

    expect(write).toHaveBeenCalledWith("block_place", { hand: 0 });
  });

  it("acknowledges initial spawn and respawn on 1.21.4+", async () => {
    const { bot, events, write } = fakeBot(false, 769);
    installMineflayerProtocolCompatibility(bot);

    events.emit("spawn");
    await Promise.resolve();
    events.emit("spawn");
    await Promise.resolve();

    expect(write).toHaveBeenNthCalledWith(1, "player_loaded", {});
    expect(write).toHaveBeenNthCalledWith(2, "player_loaded", {});
  });

  it("does not duplicate a native player-loaded acknowledgement", async () => {
    const { bot, events, write } = fakeBot(false, 769);
    installMineflayerProtocolCompatibility(bot);

    bot._client.write("player_loaded", {});
    events.emit("spawn");
    await Promise.resolve();

    expect(write).toHaveBeenCalledTimes(1);
    expect(write).toHaveBeenCalledWith("player_loaded", {});
  });
});
