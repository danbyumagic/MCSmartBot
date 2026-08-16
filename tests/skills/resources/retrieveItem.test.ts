import { EventEmitter } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Vec3 } from "vec3";
import { openDatabase, type DB } from "../../../src/memory/db.js";
import {
  getContainerItems,
  replaceContainerSnapshot,
} from "../../../src/memory/containers.js";
import { upsertLocation } from "../../../src/memory/locations.js";
import { retrieveItem } from "../../../src/skills/resources/retrieveItem.js";
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

describe("retrieveItem", () => {
  it("returns indexMissing when no indexed stock exists", async () => {
    const bot = {
      registry: { itemsByName: { coal: { id: 263 } } },
      inventory: { items: () => [] },
    };
    const result = await retrieveItem(db).run(
      { item: "coal", quantity: 8 },
      makeCtx(bot),
    );
    expect(result).toMatchObject({
      ok: false,
      code: "NO_MATERIAL",
      details: { indexMissing: true },
    });
  });

  it("withdraws indexed stock, refreshes the snapshot, and reaches target inventory", async () => {
    upsertLocation(db, { name: "main", x: 1, y: 2, z: 3 });
    replaceContainerSnapshot(db, {
      name: "main", dimension: "overworld", x: 1, y: 2, z: 3, blockType: "chest",
      items: [{ item: "coal", itemType: 263, metadata: 0, count: 16 }],
    });

    let carried = 2;
    let stored = 16;
    const position = new Vec3(1, 2, 3);
    const block = { name: "chest", position };
    const container = Object.assign(new EventEmitter(), {
      containerItems: vi.fn(() =>
        stored > 0 ? [{ name: "coal", type: 263, metadata: 0, count: stored }] : [],
      ),
      withdraw: vi.fn(async (_type: number, _metadata: number, count: number) => {
        stored -= count;
        carried += count;
      }),
      close: vi.fn(),
    });
    const bot = {
      registry: { itemsByName: { coal: { id: 263 } } },
      inventory: { items: () => carried > 0 ? [{ name: "coal", count: carried }] : [] },
      pathfinder: { goto: vi.fn().mockResolvedValue(undefined), setGoal: vi.fn() },
      blockAt: vi.fn().mockReturnValue(block),
      openContainer: vi.fn().mockResolvedValue(container),
    };

    const result = await retrieveItem(db).run(
      { item: "coal", quantity: 10 },
      makeCtx(bot),
    );

    expect(container.withdraw).toHaveBeenCalledWith(263, 0, 8);
    expect(result).toMatchObject({ ok: true, data: { retrieved: 8, total: 10 } });
    expect(getContainerItems(db, "main")).toEqual([
      { item: "coal", itemType: 263, metadata: 0, count: 8 },
    ]);
    expect(container.close).toHaveBeenCalledOnce();
  });

  it("reports stale indexed stock as a recoverable shortfall", async () => {
    upsertLocation(db, { name: "main", x: 1, y: 2, z: 3 });
    replaceContainerSnapshot(db, {
      name: "main", dimension: "overworld", x: 1, y: 2, z: 3, blockType: "chest",
      items: [{ item: "coal", itemType: 263, metadata: 0, count: 16 }],
    });
    const block = { name: "chest", position: new Vec3(1, 2, 3) };
    const container = Object.assign(new EventEmitter(), {
      containerItems: vi.fn().mockReturnValue([]),
      close: vi.fn(),
    });
    const bot = {
      registry: { itemsByName: { coal: { id: 263 } } },
      inventory: { items: () => [] },
      pathfinder: { goto: vi.fn().mockResolvedValue(undefined), setGoal: vi.fn() },
      blockAt: vi.fn().mockReturnValue(block),
      openContainer: vi.fn().mockResolvedValue(container),
    };
    const result = await retrieveItem(db).run(
      { item: "coal", quantity: 4 },
      makeCtx(bot),
    );
    expect(result).toMatchObject({ ok: false, code: "NO_MATERIAL" });
    expect(getContainerItems(db, "main")).toEqual([]);
  });
});
