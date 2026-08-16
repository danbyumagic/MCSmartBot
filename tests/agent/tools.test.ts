import { describe, it, expect, vi } from "vitest";
import { createSayTool, createSayPublicTool } from "../../src/agent/tools.js";

describe("say tool", () => {
  it("invokes sendChat with the message", async () => {
    const sendChat = vi.fn();
    const recordBotReply = vi.fn();
    const tool = createSayTool(sendChat, recordBotReply);
    const result = await tool.handler({ text: "hello" });
    expect(sendChat).toHaveBeenCalledWith("hello");
    expect(recordBotReply).toHaveBeenCalledWith("hello");
    expect(result.ok).toBe(true);
  });

  it("rejects empty text via schema", () => {
    const tool = createSayTool(() => {}, () => {});
    expect(() => tool.inputSchema.parse({ text: "" })).toThrow();
  });

  it("normalizes uppercase to lowercase", async () => {
    const sendChat = vi.fn();
    const recordBotReply = vi.fn();
    const tool = createSayTool(sendChat, recordBotReply);
    await tool.handler({ text: "Hello THERE" });
    expect(sendChat).toHaveBeenCalledWith("hello there");
    expect(recordBotReply).toHaveBeenCalledWith("hello there");
  });

  it("replaces em dashes with spaces", async () => {
    const sendChat = vi.fn();
    const tool = createSayTool(sendChat, () => {});
    await tool.handler({ text: "on my way — be right there" });
    expect(sendChat).toHaveBeenCalledWith("on my way be right there");
  });

  it("collapses internal whitespace", async () => {
    const sendChat = vi.fn();
    const tool = createSayTool(sendChat, () => {});
    await tool.handler({ text: "got  it\n\n  coming" });
    expect(sendChat).toHaveBeenCalledWith("got it coming");
  });

  it("returns ok:false when normalization leaves empty text", async () => {
    const sendChat = vi.fn();
    const tool = createSayTool(sendChat, () => {});
    const result = await tool.handler({ text: "   —  " });
    expect(result.ok).toBe(false);
    expect(sendChat).not.toHaveBeenCalled();
  });
});

describe("sayPublic tool", () => {
  it("forwards normalized text to sendPublicChat (not sendChat)", async () => {
    const sendPublicChat = vi.fn();
    const recordBotReply = vi.fn();
    const tool = createSayPublicTool(sendPublicChat, recordBotReply);
    await tool.handler({ text: "Hello Everyone!" });
    expect(sendPublicChat).toHaveBeenCalledWith("hello everyone!");
    expect(recordBotReply).toHaveBeenCalledWith("hello everyone!");
  });

  it("rejects empty input via the schema", () => {
    const tool = createSayPublicTool(() => {}, () => {});
    expect(() => tool.inputSchema.parse({ text: "" })).toThrow();
  });
});
