import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createZigzagOffsets,
  createQueryWorldMapTool,
  createStartSurveyTool,
} from "../../src/agent/explorationTools.js";
import { recordWorldObservations } from "../../src/exploration/store.js";
import { openDatabase, type DB } from "../../src/memory/db.js";

const surveyActor = {
  username: "surveyor",
  role: "operator" as const,
  source: "minecraft-chat" as const,
};
const surveyActorProvider = () => surveyActor;

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

describe("exploration tools", () => {
  it("creates a durable nine-point survey route", async () => {
    const tasks = {
      create: vi.fn((input) => ({
        id: 7,
        title: input.title,
        steps: input.steps.map((step: unknown, id: number) => ({ id, ...step as object })),
      })),
    } as any;
    const result = await createStartSurveyTool(tasks, surveyActorProvider).handler({
      dimension: "overworld",
      centerX: 100, centerY: 64, centerZ: 200,
      spacing: 24,
      gridSize: 3,
      routePattern: "zigzag",
      scanRadius: 16,
      label: "east",
    });
    expect(result.summary).toContain("9 points");
    const input = tasks.create.mock.calls[0]?.[0];
    expect(input.actor).toEqual(surveyActor);
    expect(input.steps).toHaveLength(9);
    expect(input.steps[0]).toMatchObject({
      skill: "surveyArea",
      params: { centerX: 76, centerY: 64, centerZ: 176 },
      maxAttempts: 3,
    });
  });

  it("builds a contiguous lawnmower zigzag route", () => {
    const route = createZigzagOffsets(3);
    expect(route).toEqual([
      [-1, -1], [0, -1], [1, -1],
      [1, 0], [0, 0], [-1, 0],
      [-1, 1], [0, 1], [1, 1],
    ]);
    for (let index = 1; index < route.length; index++) {
      const [x1, z1] = route[index - 1]!;
      const [x2, z2] = route[index]!;
      expect(Math.abs(x2 - x1) + Math.abs(z2 - z1)).toBe(1);
    }
  });

  it("queries observations and rejects incomplete centers", async () => {
    recordWorldObservations(db, [{
      dimension: "overworld",
      x: 2, y: 64, z: 3,
      kind: "resource",
      name: "iron_ore",
    }], 100);
    const tool = createQueryWorldMapTool(db);
    const found = await tool.handler({
      dimension: "overworld",
      kind: "resource",
      name: "iron",
      centerX: 0, centerY: 64, centerZ: 0,
      radius: 10,
      limit: 20,
    });
    expect(found.summary).toContain('"iron_ore"');
    const invalid = await tool.handler({
      centerX: 0,
      centerY: undefined,
      centerZ: undefined,
      dimension: undefined,
      kind: undefined,
      name: undefined,
      radius: undefined,
      limit: 20,
    });
    expect(invalid).toMatchObject({ ok: false, code: "INVALID_PARAMS" });
  });
});
