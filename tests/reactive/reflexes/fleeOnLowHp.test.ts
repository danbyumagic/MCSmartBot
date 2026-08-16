import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDatabase, type DB } from "../../../src/memory/db.js";
import { fleeOnLowHp } from "../../../src/reactive/reflexes/fleeOnLowHp.js";

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

describe("fleeOnLowHp check()", () => {
  it("returns true when health is below the threshold", () => {
    const reflex = fleeOnLowHp({ db, ownerUsername: "alice", hpThreshold: 6 });
    expect(reflex.check({ health: 5 } as Parameters<typeof reflex.check>[0])).toBe(true);
  });

  it("returns false when health is above the threshold", () => {
    const reflex = fleeOnLowHp({ db, ownerUsername: "alice", hpThreshold: 6 });
    expect(reflex.check({ health: 18 } as Parameters<typeof reflex.check>[0])).toBe(false);
  });

  it("returns false when bot.health is not a number (not yet spawned)", () => {
    const reflex = fleeOnLowHp({ db, ownerUsername: "alice", hpThreshold: 6 });
    expect(reflex.check({} as Parameters<typeof reflex.check>[0])).toBe(false);
  });
});
