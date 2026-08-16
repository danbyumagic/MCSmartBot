import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDatabase, type DB } from "../../src/memory/db.js";
import { getFactsByTopic } from "../../src/memory/facts.js";
import { getLocation } from "../../src/memory/locations.js";
import { getOpenGoal } from "../../src/memory/goals.js";
import {
  createRememberFactTool,
  createRememberLocationTool,
  createRecallTool,
  createSetGoalTool,
} from "../../src/agent/memoryTools.js";

let tmp: string;
let db: DB;
beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "smbmc-"));
  db = openDatabase(join(tmp, "memory.sqlite"));
});
afterEach(() => {
  db.close();
  rmSync(tmp, { recursive: true, force: true });
});

describe("createRememberFactTool", () => {
  it("stores a fact", async () => {
    const tool = createRememberFactTool(db);
    const result = await tool.handler({
      topic: "preferences",
      text: "owner prefers cobble walls",
    });
    expect(result.ok).toBe(true);
    expect(getFactsByTopic(db, "preferences").map((r) => r.text)).toEqual(["owner prefers cobble walls"]);
  });

  it("rejects empty topic via the schema", () => {
    const tool = createRememberFactTool(db);
    expect(() => tool.inputSchema.parse({ topic: "", text: "x" })).toThrow();
  });

  it("rememberFact uses the source returned by the getter", async () => {
    const tool = createRememberFactTool(db, () => "cli");
    await tool.handler({ topic: "test", text: "from cli" });
    const rows = getFactsByTopic(db, "test");
    expect(rows).toHaveLength(1);
    expect(rows[0]?.source).toBe("cli");
  });

  it("rememberFact uses observation as the fallback when no getter is supplied", async () => {
    const tool = createRememberFactTool(db);
    await tool.handler({ topic: "test", text: "fallback" });
    const rows = getFactsByTopic(db, "test");
    expect(rows[0]?.source).toBe("observation");
  });
});

describe("createRememberLocationTool", () => {
  it("stores a location with default dimension", async () => {
    const tool = createRememberLocationTool(db);
    await tool.handler({ name: "base", x: 100, y: 64, z: -200, dimension: "overworld", notes: "main hideout" });
    const row = getLocation(db, "base");
    expect(row?.x).toBe(100);
    expect(row?.dimension).toBe("overworld");
  });

  it("overwrites the location when called twice with the same name", async () => {
    const tool = createRememberLocationTool(db);
    await tool.handler({ name: "base", x: 0, y: 64, z: 0, dimension: "overworld", notes: "" });
    await tool.handler({ name: "base", x: 50, y: 70, z: 50, dimension: "overworld", notes: "" });
    expect(getLocation(db, "base")?.x).toBe(50);
  });
});

describe("createRecallTool", () => {
  it("returns matching memories in the summary", async () => {
    const tool = createRecallTool(db);
    const remember = createRememberFactTool(db);
    await remember.handler({ topic: "iron", text: "south vein exhausted" });
    const result = await tool.handler({ query: "vein", limit: 5 });
    expect(result.ok).toBe(true);
    expect(result.summary).toMatch(/south vein/);
  });

  it("returns 'no matches' when nothing matches", async () => {
    const tool = createRecallTool(db);
    const result = await tool.handler({ query: "nothing", limit: 5 });
    expect(result.ok).toBe(true);
    expect(result.summary).toMatch(/no matches|no memory/i);
  });
});

describe("createSetGoalTool", () => {
  it("sets a new open goal when text is provided", async () => {
    const tool = createSetGoalTool(db);
    await tool.handler({ text: "keep me supplied with iron", clear: false });
    expect(getOpenGoal(db)?.text).toMatch(/iron/);
  });

  it("clears the open goal when clear:true is provided", async () => {
    const tool = createSetGoalTool(db);
    await tool.handler({ text: "first goal", clear: false });
    await tool.handler({ text: "", clear: true });
    expect(getOpenGoal(db)).toBeUndefined();
  });

  it("returns ok:false when neither text nor clear is provided", async () => {
    const tool = createSetGoalTool(db);
    const result = await tool.handler({ text: "", clear: false });
    expect(result.ok).toBe(false);
    expect(result.summary).toMatch(/provide.*text|clear/i);
  });
});
