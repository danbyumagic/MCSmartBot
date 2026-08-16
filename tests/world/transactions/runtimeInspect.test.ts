import { describe, expect, it, vi } from "vitest";
import { Vec3 } from "vec3";
import { inspectJournalBlock } from "../../../src/world/transactions/runtimeInspect.js";

describe("transaction runtime inspection", () => {
  it("converts the serialized journal position to Vec3 before Mineflayer lookup", () => {
    const blockAt = vi.fn((position: Vec3) => {
      // Mineflayer's world lookup calls this Vec3 method internally. A plain
      // `{ x, y, z }` journal record would throw here.
      const floored = position.floored();
      return {
        name: "stone",
        position: floored,
        boundingBox: "block",
        diggable: true,
        getProperties: () => ({ axis: "y" }),
      };
    });

    const snapshot = inspectJournalBlock({ blockAt }, { x: 3, y: 64, z: -2 });

    expect(blockAt).toHaveBeenCalledWith(expect.any(Vec3));
    expect(snapshot).toMatchObject({
      name: "stone",
      position: { x: 3, y: 64, z: -2 },
      properties: { axis: "y" },
    });
  });
});
