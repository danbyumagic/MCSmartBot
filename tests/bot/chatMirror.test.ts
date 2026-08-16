import { describe, it, expect, vi } from "vitest";
import { wireChatMirror } from "../../src/bot/chatMirror.js";

function makeBot() {
  let listener: ((text: string) => void) | null = null;
  const bot = {
    on: (event: string, fn: (text: string) => void) => {
      if (event === "messagestr") listener = fn;
    },
  } as unknown as Parameters<typeof wireChatMirror>[0]["bot"];
  return { bot, fire: (text: string) => listener?.(text) };
}

describe("wireChatMirror", () => {
  it("writes every messagestr to the provided sink", () => {
    const { bot, fire } = makeBot();
    const write = vi.fn();
    wireChatMirror({ bot, write });
    fire("<xxdj> hello");
    fire("[me -> xxdj] hi");
    fire("xxdj has requested to teleport to you");
    expect(write).toHaveBeenNthCalledWith(1, "<xxdj> hello");
    expect(write).toHaveBeenNthCalledWith(2, "[me -> xxdj] hi");
    expect(write).toHaveBeenNthCalledWith(3, "xxdj has requested to teleport to you");
  });

  it("ignores empty messages", () => {
    const { bot, fire } = makeBot();
    const write = vi.fn();
    wireChatMirror({ bot, write });
    fire("");
    expect(write).not.toHaveBeenCalled();
  });
});
