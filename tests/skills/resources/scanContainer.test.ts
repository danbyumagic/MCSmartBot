import { EventEmitter } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Vec3 } from "vec3";
import { openDatabase, type DB } from "../../../src/memory/db.js";
import { getContainerItems } from "../../../src/memory/containers.js";
import { upsertLocation } from "../../../src/memory/locations.js";
import { scanContainer } from "../../../src/skills/resources/scanContainer.js";
import type { SkillContext } from "../../../src/skills/types.js";

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

function makeCtx(bot: unknown): SkillContext {
  const log = {
    debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn(), trace: vi.fn(), fatal: vi.fn(),
    child: () => log, level: "error", bindings: () => ({}),
  } as unknown as SkillContext["log"];
  return {
    bot: bot as SkillContext["bot"],
    signal: new AbortController().signal,
    log,
    reportProgress: vi.fn(),
  };
}

describe("scanContainer", () => {
  it("requires a remembered location", async () => {
    const result = await scanContainer(db).run({ chestName: "main" }, makeCtx({}));
    expect(result).toMatchObject({ ok: false, code: "NOT_CONFIGURED" });
  });

  it("indexes live container contents and closes it", async () => {
    upsertLocation(db, { name: "main", x: 1, y: 2, z: 3 });
    const position = new Vec3(1, 2, 3);
    const block = { name: "chest", position };
    const container = Object.assign(new EventEmitter(), {
      containerItems: vi.fn().mockReturnValue([
        { name: "coal", type: 263, metadata: 0, count: 8 },
      ]),
      close: vi.fn(),
    });
    const bot = {
      pathfinder: { goto: vi.fn().mockResolvedValue(undefined), setGoal: vi.fn() },
      blockAt: vi.fn().mockReturnValue(block),
      openContainer: vi.fn().mockResolvedValue(container),
    };
    const result = await scanContainer(db).run({ chestName: "main" }, makeCtx(bot));
    expect(result.ok).toBe(true);
    expect(getContainerItems(db, "main")).toEqual([
      { item: "coal", itemType: 263, metadata: 0, count: 8 },
    ]);
    expect(container.close).toHaveBeenCalledOnce();
  });
});
