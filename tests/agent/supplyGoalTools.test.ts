import { describe, expect, it, vi } from "vitest";
import {
  createGetSupplyGoalTool,
  createManageSupplyGoalTool,
  createStandingSupplyGoalTool,
} from "../../src/agent/supplyGoalTools.js";

describe("supply goal tools", () => {
  it("creates a standing supply goal", async () => {
    const scheduler = {
      create: vi.fn().mockReturnValue({
        id: 4, containerName: "base", item: "iron_ingot", targetQuantity: 64,
      }),
    } as any;
    const result = await createStandingSupplyGoalTool(scheduler).handler({
      chestName: "base",
      item: "iron_ingot",
      quantity: 64,
      searchRadius: 64,
      intervalMinutes: 15,
    });
    expect(result.ok).toBe(true);
    expect(result.summary).toContain("supply goal 4");
    expect(scheduler.create).toHaveBeenCalledWith({
      containerName: "base",
      item: "iron_ingot",
      targetQuantity: 64,
      searchRadius: 64,
      intervalMinutes: 15,
    });
  });

  it("reads goal status", async () => {
    const scheduler = {
      get: vi.fn().mockReturnValue({
        id: 4,
        status: "active",
        containerName: "base",
        item: "iron_ingot",
        targetQuantity: 64,
        intervalMinutes: 15,
        nextCheckAt: 123,
        lastPlanId: 9,
        lastError: null,
      }),
    } as any;
    const result = await createGetSupplyGoalTool(scheduler).handler({ goalId: 4 });
    expect(result.summary).toContain('"status":"active"');
    expect(result.summary).toContain('"lastPlanId":9');
  });

  it("maps resume to active status", async () => {
    const scheduler = { setStatus: vi.fn().mockReturnValue(true) } as any;
    const result = await createManageSupplyGoalTool(scheduler).handler({
      goalId: 4,
      action: "resume",
    });
    expect(result.ok).toBe(true);
    expect(scheduler.setStatus).toHaveBeenCalledWith(4, "active");
  });
});
