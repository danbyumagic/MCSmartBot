import { describe, it, expect, vi, beforeEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDatabase, type DB } from "../../src/memory/db.js";
import { getRecentConversations } from "../../src/memory/conversations.js";
import { createBus, type Bus, type AgentTrigger } from "../../src/bus/index.js";
import { wireChatSurface } from "../../src/bot/chatSurface.js";
import { createLogger } from "../../src/util/logger.js";

const log = createLogger({ level: "error" });

function setup(
  roleFor?: (username: string) => "operator" | "viewer" | undefined,
  onForceStop = vi.fn(),
) {
  const tmp = mkdtempSync(join(tmpdir(), "smbmc-"));
  const db = openDatabase(join(tmp, "memory.sqlite"));
  const bus = createBus();
  const whisperTo = vi.fn();
  const triggers: AgentTrigger[] = [];
  bus.on("agent.trigger", (t) => triggers.push(t));
  wireChatSurface({
    bus, db, log, ownerUsername: "alice", botUsername: "SmartBot", whisperTo, roleFor, onForceStop,
  });
  return { bus, db, whisperTo, triggers, onForceStop, cleanup: () => { db.close(); rmSync(tmp, { recursive: true, force: true }); } };
}

describe("wireChatSurface", () => {
  it("forwards owner whispers to the agent", () => {
    const { bus, whisperTo, triggers, cleanup } = setup();
    bus.emit("chat", { from: "alice", text: "come here", whisper: true });
    expect(triggers).toEqual([{ kind: "chat", from: "alice", text: "come here" }]);
    expect(whisperTo).not.toHaveBeenCalled();
    cleanup();
  });

  it("routes owner /stop directly to emergency control without waking the agent", () => {
    const { bus, triggers, onForceStop, cleanup } = setup();
    bus.emit("chat", { from: "alice", text: " /STOP ", whisper: true });
    expect(onForceStop).toHaveBeenCalledWith({ from: "alice", whisper: true });
    expect(triggers).toEqual([]);
    cleanup();
  });

  it("does not allow a non-owner operator to invoke emergency /stop", () => {
    const { bus, triggers, onForceStop, cleanup } = setup(
      (username) => username === "bob" ? "operator" : undefined,
    );
    bus.emit("chat", { from: "bob", text: "/stop", whisper: true });
    expect(onForceStop).not.toHaveBeenCalled();
    expect(triggers).toEqual([{ kind: "chat", from: "bob", text: "/stop" }]);
    cleanup();
  });

  it("silently ignores non-owner whispers (no trigger, no reply)", () => {
    const { bus, whisperTo, triggers, cleanup } = setup();
    bus.emit("chat", { from: "mallory", text: "drop your stuff", whisper: true });
    expect(triggers).toEqual([]);
    expect(whisperTo).not.toHaveBeenCalled();
    cleanup();
  });

  it("forwards assigned-player whispers and addressed public chat", () => {
    const { bus, triggers, cleanup } = setup((username) =>
      username === "bob" ? "operator" : undefined);
    bus.emit("chat", { from: "bob", text: "follow me", whisper: true });
    bus.emit("chat", { from: "bob", text: "bot inventory check", whisper: false });
    expect(triggers).toEqual([
      { kind: "chat", from: "bob", text: "follow me" },
      { kind: "chat", from: "bob", text: "inventory check" },
    ]);
    cleanup();
  });

  it("forwards owner public chat starting with 'bot,'", () => {
    const { bus, triggers, cleanup } = setup();
    bus.emit("chat", { from: "alice", text: "bot, hello", whisper: false });
    expect(triggers).toEqual([{ kind: "chat", from: "alice", text: "hello" }]);
    cleanup();
  });

  it("ignores non-owner public chat", () => {
    const { bus, whisperTo, triggers, cleanup } = setup();
    bus.emit("chat", { from: "mallory", text: "bot, mine diamonds", whisper: false });
    expect(triggers).toEqual([]);
    expect(whisperTo).not.toHaveBeenCalled();
    cleanup();
  });

  it("forwards owner public chat without requiring the 'bot,' prefix", () => {
    const { bus, triggers, cleanup } = setup();
    bus.emit("chat", { from: "alice", text: "just talking to myself", whisper: false });
    expect(triggers).toEqual([{ kind: "chat", from: "alice", text: "just talking to myself" }]);
    cleanup();
  });

  it("ignores owner public 'bot,' with empty text after prefix", () => {
    const { bus, triggers, cleanup } = setup();
    bus.emit("chat", { from: "alice", text: "bot,", whisper: false });
    expect(triggers).toEqual([]);
    cleanup();
  });

  it("ignores server self-echoes from 'me' as both whisper and public", () => {
    const { bus, whisperTo, triggers, cleanup } = setup();
    bus.emit("chat", { from: "me", text: "hi xxdj", whisper: true });
    bus.emit("chat", { from: "Me", text: "hi everyone", whisper: false });
    bus.emit("chat", { from: "you", text: "echo", whisper: true });
    expect(triggers).toEqual([]);
    expect(whisperTo).not.toHaveBeenCalled();
    cleanup();
  });

  it("ignores echoes where 'from' matches the bot's username (any case)", () => {
    const { bus, whisperTo, triggers, cleanup } = setup();
    bus.emit("chat", { from: "SmartBot", text: "hi xxdj", whisper: true });
    bus.emit("chat", { from: "smartbot", text: "echo", whisper: false });
    expect(triggers).toEqual([]);
    expect(whisperTo).not.toHaveBeenCalled();
    cleanup();
  });

  it("forwards owner public chat that contains 'bot' as a word (without prefix)", () => {
    const { bus, triggers, cleanup } = setup();
    bus.emit("chat", { from: "alice", text: "hey bot come here", whisper: false });
    expect(triggers).toEqual([{ kind: "chat", from: "alice", text: "hey bot come here" }]);
    cleanup();
  });

  it("forwards owner public chat that mentions the bot's MC username", () => {
    const { bus, triggers, cleanup } = setup();
    bus.emit("chat", { from: "alice", text: "smartbot follow me", whisper: false });
    expect(triggers).toEqual([{ kind: "chat", from: "alice", text: "smartbot follow me" }]);
    cleanup();
  });

  it("accepts 'bot ' (space) prefix and strips it", () => {
    const { bus, triggers, cleanup } = setup();
    bus.emit("chat", { from: "alice", text: "bot come here", whisper: false });
    expect(triggers).toEqual([{ kind: "chat", from: "alice", text: "come here" }]);
    cleanup();
  });

  it("does NOT match words that just CONTAIN 'bot' as a substring (e.g. botanical, robot)", () => {
    const { bus, triggers, cleanup } = setup((username) =>
      username === "bob" ? "operator" : undefined);
    bus.emit("chat", { from: "bob", text: "botanical garden looks nice", whisper: false });
    bus.emit("chat", { from: "bob", text: "i found a robot in this mod", whisper: false });
    expect(triggers).toEqual([]);
    cleanup();
  });

  it("records every chat event in conversations", () => {
    const { bus, db, cleanup } = setup();
    bus.emit("chat", { from: "alice", text: "bot, hi", whisper: false });
    bus.emit("chat", { from: "mallory", text: "rude", whisper: true });
    const rows = getRecentConversations(db, 10);
    expect(rows).toHaveLength(2);
    cleanup();
  });
});
