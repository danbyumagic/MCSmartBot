import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDatabase, type DB } from "../../../src/memory/db.js";
import { upsertInventoryPolicy } from "../../../src/memory/inventoryPolicies.js";
import { restockInventory } from "../../../src/skills/resources/restockInventory.js";
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

describe("restockInventory", () => {
  it("requires a configured policy", async () => {
    const result = await restockInventory(db).run(
      { policyName: "default" },
      makeCtx({}),
    );
    expect(result).toMatchObject({ ok: false, code: "NOT_CONFIGURED" });
  });

  it("succeeds when all minimums are already carried", async () => {
    upsertInventoryPolicy(db, {
      name: "default",
      alwaysCarry: { torch: 32, bread: 8 },
    });
    const bot = {
      registry: { itemsByName: { torch: { id: 50 }, bread: { id: 297 } } },
      inventory: {
        items: () => [
          { name: "torch", count: 40 },
          { name: "bread", count: 8 },
        ],
      },
    };
    const result = await restockInventory(db).run(
      { policyName: "default" },
      makeCtx(bot),
    );
    expect(result).toMatchObject({ ok: true, data: { policyName: "default" } });
  });

  it("returns structured unmet minimums", async () => {
    upsertInventoryPolicy(db, {
      name: "default",
      alwaysCarry: { torch: 32 },
    });
    const bot = {
      registry: { itemsByName: { torch: { id: 50 } } },
      inventory: { items: () => [] },
    };
    const result = await restockInventory(db).run(
      { policyName: "default" },
      makeCtx(bot),
    );
    expect(result).toMatchObject({
      ok: false,
      code: "NO_MATERIAL",
      details: {
        failures: [{ item: "torch", target: 32, code: "NO_MATERIAL" }],
      },
    });
  });
});
