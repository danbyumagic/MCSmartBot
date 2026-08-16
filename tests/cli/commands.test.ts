import { describe, it, expect } from "vitest";
import { parseCliCommand } from "../../src/cli/commands.js";

describe("parseCliCommand", () => {
  it("treats empty input as noop", () => {
    expect(parseCliCommand("")).toEqual({ kind: "noop" });
    expect(parseCliCommand("   ")).toEqual({ kind: "noop" });
  });

  it("treats plain text as a public chat message", () => {
    expect(parseCliCommand("hello everyone")).toEqual({ kind: "chat", text: "hello everyone" });
    expect(parseCliCommand("  trims whitespace  ")).toEqual({ kind: "chat", text: "trims whitespace" });
  });

  it("parses ask as a private AI-agent instruction", () => {
    expect(parseCliCommand("ask come to me")).toEqual({
      kind: "agent",
      text: "come to me",
    });
    expect(parseCliCommand("ASK   build a shelter")).toEqual({
      kind: "agent",
      text: "build a shelter",
    });
  });

  it("parses '/cmd' as a server slash command and strips the leading slash", () => {
    expect(parseCliCommand("/tp xxdj")).toEqual({ kind: "command", command: "tp xxdj" });
    expect(parseCliCommand("/gamemode creative")).toEqual({ kind: "command", command: "gamemode creative" });
  });

  it("treats a bare '/' as noop (no command to run)", () => {
    expect(parseCliCommand("/")).toEqual({ kind: "noop" });
    expect(parseCliCommand("/   ")).toEqual({ kind: "noop" });
  });

  it("reserves 'quit' and 'exit' for shutdown", () => {
    expect(parseCliCommand("quit")).toEqual({ kind: "quit" });
    expect(parseCliCommand("exit")).toEqual({ kind: "quit" });
  });

  it("reserves 'status' for a state dump", () => {
    expect(parseCliCommand("status")).toEqual({ kind: "status" });
  });

  it("plain text that happens to contain 'quit' as a substring still goes to chat", () => {
    expect(parseCliCommand("im about to quit lol")).toEqual({ kind: "chat", text: "im about to quit lol" });
  });
});
