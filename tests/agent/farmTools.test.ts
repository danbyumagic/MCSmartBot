import { describe, expect, it, vi } from "vitest";
import {
  createGetFarmTool,
  createManageFarmTool,
  createRegisterFarmTool,
} from "../../src/agent/farmTools.js";

const base = {
  name: "wheat",
  dimension: "overworld",
  minX: 0, minY: 65, minZ: 0,
  maxX: 3, maxY: 65, maxZ: 3,
  crop: "wheat" as const,
  seedReserve: 16,
  intervalMinutes: 15,
};

describe("farm tools", () => {
  it("registers a bounded farm", async () => {
    const scheduler = {
      register: vi.fn().mockReturnValue({ id: 2, name: "wheat", crop: "wheat" }),
    } as any;
    const result = await createRegisterFarmTool(scheduler).handler(base);
    expect(result.ok).toBe(true);
    expect(scheduler.register).toHaveBeenCalledWith(base);
  });

  it("rejects an excessively broad farm boundary", async () => {
    const scheduler = { register: vi.fn() } as any;
    const result = await createRegisterFarmTool(scheduler).handler({
      ...base,
      maxX: 100,
      maxZ: 100,
    });
    expect(result).toMatchObject({ ok: false, code: "INVALID_PARAMS" });
    expect(scheduler.register).not.toHaveBeenCalled();
  });

  it("reads and manages registered farms", async () => {
    const scheduler = {
      get: vi.fn().mockReturnValue({
        id: 2, name: "wheat", status: "active", crop: "wheat",
        minX: 0, minY: 65, minZ: 0, maxX: 3, maxY: 65, maxZ: 3,
        storageName: null, seedReserve: 16, intervalMinutes: 15,
        nextCheckAt: 10, lastPlanId: 4, lastError: null,
      }),
      setStatus: vi.fn().mockReturnValue(true),
    } as any;
    const read = await createGetFarmTool(scheduler).handler({ farmId: 2 });
    expect(read.summary).toContain('"crop":"wheat"');
    const managed = await createManageFarmTool(scheduler).handler({
      farmId: 2, action: "pause",
    });
    expect(managed.ok).toBe(true);
    expect(scheduler.setStatus).toHaveBeenCalledWith(2, "paused");
  });
});
