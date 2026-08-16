import { describe, it, expect } from "vitest";
import { parseChatLine, parseWhisperLine, PATTERNS, WHISPER_PATTERNS } from "../../src/bot/chatPatterns.js";

describe("parseChatLine (pure parser for testing — mirrors what mineflayer chatAddPattern does)", () => {
  it("matches vanilla <player> message", () => {
    expect(parseChatLine("<alice> hello world")).toEqual({ kind: "chat", from: "alice", text: "hello world" });
  });

  it("matches [rank] <player> message (luckperms-vanilla-prefix)", () => {
    expect(parseChatLine("[Owner] <alice> hi")).toEqual({ kind: "chat", from: "alice", text: "hi" });
  });

  it("matches [rank] player » message (essentials-style with chevron)", () => {
    expect(parseChatLine("[VIP] alice » how are you")).toEqual({ kind: "chat", from: "alice", text: "how are you" });
  });

  it("matches decorated network chat before a rank prefix", () => {
    expect(parseChatLine("▎ [Admin]  xxdj » welcome")).toEqual({
      kind: "chat",
      from: "xxdj",
      text: "welcome",
    });
  });

  it("matches [rank] player: message (colon style)", () => {
    expect(parseChatLine("[Member] alice: greetings")).toEqual({ kind: "chat", from: "alice", text: "greetings" });
  });

  it("matches bare player: message", () => {
    expect(parseChatLine("alice: greetings")).toEqual({ kind: "chat", from: "alice", text: "greetings" });
  });

  it("matches bare player » message", () => {
    expect(parseChatLine("alice » greetings")).toEqual({ kind: "chat", from: "alice", text: "greetings" });
  });

  it("does NOT match server prefixes like [Server]: ...", () => {
    expect(parseChatLine("[Server]: restarting in 5 minutes")).toBeNull();
  });

  it("does NOT match Console messages", () => {
    expect(parseChatLine("Console: warning")).toBeNull();
  });

  it("does NOT match overlong fake usernames", () => {
    // 17 chars — too long to be a Minecraft username
    expect(parseChatLine("AAAAAAAAAAAAAAAAAA: trying to spoof")).toBeNull();
  });

  it("does NOT match usernames with disallowed characters", () => {
    expect(parseChatLine("[bot.system]: status report")).toBeNull();
    expect(parseChatLine("not-a-name: hi")).toBeNull();
  });

  it("exposes the underlying patterns for chatAddPattern wiring", () => {
    expect(Array.isArray(PATTERNS)).toBe(true);
    expect(PATTERNS.length).toBeGreaterThan(0);
    for (const p of PATTERNS) {
      expect(p.regex).toBeInstanceOf(RegExp);
      expect(p.kind).toBe("chat");
      expect(typeof p.description).toBe("string");
    }
  });
});

describe("parseWhisperLine (essentials-style)", () => {
  it("matches vanilla 'X whispers to you: msg'", () => {
    expect(parseWhisperLine("xxdj whispers to you: hello bot")).toEqual({
      kind: "whisper",
      from: "xxdj",
      text: "hello bot",
    });
  });

  it("matches vanilla 'X whispers: msg' (older servers)", () => {
    expect(parseWhisperLine("xxdj whispers: hi")).toEqual({
      kind: "whisper",
      from: "xxdj",
      text: "hi",
    });
  });

  it("matches [name -> me] message (inbound whisper)", () => {
    expect(parseWhisperLine("[xxdj -> me] hello bot")).toEqual({
      kind: "whisper",
      from: "xxdj",
      text: "hello bot",
    });
  });

  it("matches [~name -> me] message (essentials nickname marker)", () => {
    expect(parseWhisperLine("[~xxdj -> me] hi")).toEqual({
      kind: "whisper",
      from: "xxdj",
      text: "hi",
    });
  });

  it("matches [rank name -> me] message", () => {
    expect(parseWhisperLine("[VIP xxdj -> me] greetings")).toEqual({
      kind: "whisper",
      from: "xxdj",
      text: "greetings",
    });
  });

  it("does NOT match [me -> name] outbound echoes (mineflayer's default catches those)", () => {
    // Critical: matching this would capture the RECIPIENT as the sender,
    // creating a feedback loop where the bot processes its own outbound
    // whispers as inbound owner commands. Mineflayer's built-in whisper
    // pattern handles `[X -> Y] msg` correctly (capturing the LEFT name as
    // the sender, which is "me" for outbound), and the chat surface drops
    // from="me". Our custom patterns must NOT compete with that.
    expect(parseWhisperLine("[me -> xxdj] reply text")).toBeNull();
    expect(parseWhisperLine("[me -> VIP alice] something")).toBeNull();
  });

  it("does NOT match overlong fake names in the inbound position", () => {
    expect(parseWhisperLine("[AAAAAAAAAAAAAAAAA -> me] msg")).toBeNull();
  });

  it("does NOT match Console / Server in the inbound position", () => {
    expect(parseWhisperLine("[Co -> me] anything")).toBeNull(); // too short
  });

  it("returns null for unrelated lines", () => {
    expect(parseWhisperLine("xxdj joined the game")).toBeNull();
    expect(parseWhisperLine("<xxdj> public chat msg")).toBeNull();
  });

  it("WHISPER_PATTERNS exposes patterns with kind:'whisper'", () => {
    expect(WHISPER_PATTERNS.length).toBeGreaterThan(0);
    for (const p of WHISPER_PATTERNS) {
      expect(p.regex).toBeInstanceOf(RegExp);
      expect(p.kind).toBe("whisper");
      expect(typeof p.description).toBe("string");
    }
  });
});
