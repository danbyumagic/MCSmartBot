import { describe, it, expect, vi } from "vitest";
import { createRunCommandTool, createStopTool } from "../../src/agent/commandTools.js";

describe("createRunCommandTool", () => {
  it("treats an explicit owner destructive order as authorization", () => {
    const tool = createRunCommandTool(async () => []);
    expect(tool.description).toMatch(/explicit destructive order/i);
    expect(tool.description).toMatch(/without asking again/i);
  });

  it("passes the command (without leading slash) to the runCommand callback", async () => {
    const send = vi.fn().mockResolvedValue([]);
    const tool = createRunCommandTool(send);
    const result = await tool.handler({ command: "tp alice" });
    expect(send).toHaveBeenCalledWith("tp alice");
    expect(result.ok).toBe(true);
    expect(result.summary).toMatch(/no visible server response/);
  });

  it("strips a leading slash if Claude provides one", async () => {
    const send = vi.fn().mockResolvedValue([]);
    const tool = createRunCommandTool(send);
    await tool.handler({ command: "/gamemode creative" });
    expect(send).toHaveBeenCalledWith("gamemode creative");
  });

  it("strips multiple leading slashes defensively", async () => {
    const send = vi.fn().mockResolvedValue([]);
    const tool = createRunCommandTool(send);
    await tool.handler({ command: "///time set day" });
    expect(send).toHaveBeenCalledWith("time set day");
  });

  it("rejects a string that becomes empty after trimming", async () => {
    const send = vi.fn().mockResolvedValue([]);
    const tool = createRunCommandTool(send);
    const result = await tool.handler({ command: "  /  " });
    expect(send).not.toHaveBeenCalled();
    expect(result.ok).toBe(false);
  });

  it("rejects empty input via the schema", () => {
    const tool = createRunCommandTool(async () => []);
    expect(() => tool.inputSchema.parse({ command: "" })).toThrow();
  });

  it("includes captured server output in the result summary", async () => {
    const send = vi.fn().mockResolvedValue([
      "There are 3 of a max of 20 players online: alice, bob, charlie",
    ]);
    const tool = createRunCommandTool(send);
    const result = await tool.handler({ command: "list" });
    expect(result.ok).toBe(true);
    expect(result.summary).toMatch(/Ran \/list/);
    expect(result.summary).toMatch(/3 of a max of 20/);
  });

  it("joins multi-line output with newlines", async () => {
    const send = vi.fn().mockResolvedValue(["line one", "line two", "line three"]);
    const tool = createRunCommandTool(send);
    const result = await tool.handler({ command: "help" });
    expect(result.summary).toMatch(/line one\nline two\nline three/);
  });
});

describe("createStopTool", () => {
  it("cancels and reports the active skill name", async () => {
    const cancel = vi.fn();
    const runner = { run: vi.fn(), cancel, activeName: () => "gotoPlayer" } as any;
    const tool = createStopTool(runner);
    const result = await tool.handler({});
    expect(cancel).toHaveBeenCalledTimes(1);
    expect(result.ok).toBe(true);
    expect(result.summary).toMatch(/gotoPlayer/);
  });

  it("is a no-op when nothing is active", async () => {
    const cancel = vi.fn();
    const runner = { run: vi.fn(), cancel, activeName: () => null } as any;
    const tool = createStopTool(runner);
    const result = await tool.handler({});
    expect(cancel).not.toHaveBeenCalled();
    expect(result.ok).toBe(true);
    expect(result.summary).toMatch(/nothing/i);
  });

  it("pauses the owning durable plan before stopping its active skill", async () => {
    const cancel = vi.fn();
    const runner = {
      run: vi.fn(),
      cancel,
      activeName: () => "buildBlueprint",
    } as any;
    const pause = vi.fn().mockReturnValue({
      planId: 7,
      paused: true,
      constructionJobId: 3,
    });
    const result = await createStopTool(runner, pause).handler({});

    expect(pause).toHaveBeenCalledOnce();
    expect(cancel).toHaveBeenCalledOnce();
    expect(result).toMatchObject({
      ok: true,
      details: {
        planId: 7,
        planPaused: true,
        constructionJobId: 3,
        resumeWith: "manageConstruction resume",
      },
    });
    expect(result.summary).toMatch(/paused task plan 7/);
  });
});
