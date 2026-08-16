import { describe, expect, it, vi } from "vitest";
import {
  createGetConstructionTool,
  createListBlueprintsTool,
  createManageConstructionTool,
  createPreviewBuildDefinitionTool,
  createRegisterBlueprintTool,
  createRegisterBuildDefinitionTool,
  createStartConstructionTool,
  previewBuildDefinitionSchema,
  registerBuildDefinitionSchema,
} from "../../src/agent/constructionTools.js";
import { zodToJsonSchema } from "zod-to-json-schema";

const constructionActor = {
  username: "builder",
  role: "operator" as const,
  source: "minecraft-chat" as const,
};
const constructionActorProvider = () => constructionActor;

describe("construction tools", () => {
  it("registers bounded blueprints and reports materials", async () => {
    const manager = {
      registerBlueprint: vi.fn().mockReturnValue({
        id: 1,
        name: "wall",
        blocks: [
          { x: 0, y: 0, z: 0, block: "stone" },
          { x: 1, y: 0, z: 0, block: "stone" },
        ],
      }),
    } as any;
    const result = await createRegisterBlueprintTool(manager).handler({
      name: "wall",
      blocks: [
        { x: 0, y: 0, z: 0, block: "stone" },
        { x: 1, y: 0, z: 0, block: "stone" },
      ],
    });
    expect(result.ok).toBe(true);
    expect(result.summary).toContain('"stone":2');
  });

  it("rejects dangerous blueprint blocks", async () => {
    const manager = { registerBlueprint: vi.fn() } as any;
    const result = await createRegisterBlueprintTool(manager).handler({
      name: "trap",
      blocks: [{ x: 0, y: 0, z: 0, block: "tnt" }],
    });
    expect(result).toMatchObject({ ok: false, code: "AREA_UNSAFE" });
    expect(manager.registerBlueprint).not.toHaveBeenCalled();
  });

  it("lists blueprint dimensions and material totals", async () => {
    const manager = {
      listBlueprints: vi.fn().mockReturnValue([{
        id: 1,
        name: "platform",
        blockCount: 2,
        size: [2, 1, 1],
        materials: { stone: 2 },
        source: null,
      }]),
    } as any;
    const result = await createListBlueprintsTool(manager).handler({});
    expect(result.ok).toBe(true);
    expect(result.summary).toContain('"size":[2,1,1]');
    expect(result.summary).toContain('"stone":2');
  });

  it("starts, reads, and manages construction jobs", async () => {
    const manager = {
      startBuild: vi.fn().mockReturnValue({
        id: 4, blueprintName: "wall", lastPlanId: 9,
      }),
      getBuild: vi.fn().mockReturnValue({
        id: 4, blueprintName: "wall", status: "blocked",
        dimension: "overworld", originX: 1, originY: 65, originZ: 2,
        rotation: 90,
        storageName: "main", placedCount: 3, totalCount: 8,
        lastPlanId: 9, lastError: "needs stone",
      }),
      manageBuild: vi.fn().mockReturnValue(true),
    } as any;
    const started = await createStartConstructionTool(
      manager,
      undefined,
      constructionActorProvider,
    ).handler({
      blueprintName: "wall",
      dimension: "overworld",
      originX: 1, originY: 65, originZ: 2,
      storageName: "main",
    });
    expect(started.summary).toContain("job 4");
    expect(manager.startBuild).toHaveBeenCalledWith(expect.objectContaining({
      actor: constructionActor,
    }));
    const read = await createGetConstructionTool(manager).handler({ jobId: 4 });
    expect(read.summary).toContain('"placedCount":3');
    const managed = await createManageConstructionTool(manager, constructionActorProvider).handler({
      jobId: 4, action: "resume",
    });
    expect(managed.ok).toBe(true);
    expect(manager.manageBuild).toHaveBeenCalledWith(4, "resume", constructionActor);
  });

  it("schedules automatic preparation when carried materials are short", async () => {
    const manager = {
      getBlueprintForExecution: vi.fn().mockReturnValue({
        name: "wall",
        placementUnits: [
          {
            anchor: { x: 0, y: 0, z: 0, block: "cobblestone" },
            item: "cobblestone",
            expectedCells: [{ x: 0, y: 0, z: 0, block: "cobblestone" }],
          },
          {
            anchor: { x: 1, y: 0, z: 0, block: "cobblestone" },
            item: "cobblestone",
            expectedCells: [{ x: 1, y: 0, z: 0, block: "cobblestone" }],
          },
          {
            anchor: { x: 2, y: 0, z: 0, block: "oak_planks" },
            item: "oak_planks",
            expectedCells: [{ x: 2, y: 0, z: 0, block: "oak_planks" }],
          },
        ],
      }),
      startBuild: vi.fn((input) => ({
        id: 5,
        blueprintName: input.blueprintName,
        lastPlanId: 10,
        ...input,
      })),
    } as any;
    const bot = {
      inventory: {
        items: () => [{ name: "cobblestone", count: 1 }],
      },
      blockAt: (position: { y: number }) => ({
        name: position.y === 64 ? "stone" : "air",
        boundingBox: position.y === 64 ? "block" : "empty",
      }),
    } as any;

    const result = await createStartConstructionTool(
      manager,
      bot,
      constructionActorProvider,
    ).handler({
      blueprintName: "wall",
      dimension: "overworld",
      originX: 1,
      originY: 65,
      originZ: 2,
    });

    expect(result.ok).toBe(true);
    expect(result.summary).toMatch(/preparation must supply 1 cobblestone, 1 oak_planks/);
    expect(result.details).toMatchObject({
      inventoryReady: false,
      requirements: [
        { item: "cobblestone", have: 1, missing: 1 },
        { item: "oak_planks", have: 0, missing: 1 },
      ],
    });
    expect(manager.startBuild).toHaveBeenCalledOnce();
  });

  it("shifts a blocked request to the nearest safe build origin", async () => {
    const manager = {
      getBlueprintForExecution: vi.fn().mockReturnValue({
        name: "marker",
        placementUnits: [{
          anchor: { x: 0, y: 0, z: 0, block: "oak_planks" },
          item: "oak_planks",
          expectedCells: [{ x: 0, y: 0, z: 0, block: "oak_planks" }],
        }],
      }),
      startBuild: vi.fn((input) => ({
        id: 6,
        blueprintName: input.blueprintName,
        lastPlanId: 11,
        ...input,
      })),
    } as any;
    const bot = {
      inventory: { items: () => [{ name: "oak_planks", count: 1 }] },
      blockAt: (position: { x: number; y: number; z: number }) => {
        const blocked = position.x === 0 && position.y === 65 && position.z === 0;
        return {
          name: blocked ? "chest" : position.y === 64 ? "stone" : "air",
          boundingBox: blocked || position.y === 64 ? "block" : "empty",
        };
      },
    } as any;

    const result = await createStartConstructionTool(
      manager,
      bot,
      constructionActorProvider,
    ).handler({
      blueprintName: "marker",
      dimension: "overworld",
      originX: 0,
      originY: 65,
      originZ: 0,
      rotation: 90,
      autoAdjustSite: true,
    });

    expect(result.ok).toBe(true);
    expect(result.details).toMatchObject({
      rotation: 90,
      adjustedFrom: { originX: 0, originY: 65, originZ: 0 },
    });
    expect(manager.startBuild).toHaveBeenCalledWith(expect.objectContaining({
      rotation: 90,
      originY: 65,
      actor: constructionActor,
    }));
    expect(manager.startBuild.mock.calls[0][0]).not.toMatchObject({
      originX: 0,
      originZ: 0,
    });
  });

  it("rejects a wrong-state hinted stair before inventory checks or job scheduling", async () => {
    const inventoryItems = vi.fn(() => [{ name: "oak_stairs", count: 1 }]);
    const manager = {
      getBlueprintForExecution: vi.fn().mockReturnValue({
        name: "hinted-stair",
        placementUnits: [{
          anchor: { x: 0, y: 0, z: 0, block: "oak_stairs" },
          item: "oak_stairs",
          expectedCells: [{ x: 0, y: 0, z: 0, block: "oak_stairs" }],
          hint: { facing: "north", half: "bottom" },
        }],
      }),
      startBuild: vi.fn(),
    } as any;
    const bot = {
      inventory: { items: inventoryItems },
      blockAt: (position: { x: number; y: number; z: number }) => {
        if (position.x === 0 && position.y === 65 && position.z === 0) {
          return {
            name: "oak_stairs",
            boundingBox: "block",
            getProperties: () => ({ facing: "east", half: "top" }),
          };
        }
        return {
          name: position.y === 64 ? "stone" : "air",
          boundingBox: position.y === 64 ? "block" : "empty",
          getProperties: () => ({}),
        };
      },
    } as any;

    const result = await createStartConstructionTool(
      manager,
      bot,
      constructionActorProvider,
    ).handler({
      blueprintName: "hinted-stair",
      dimension: "overworld",
      originX: 0,
      originY: 65,
      originZ: 0,
      autoAdjustSite: false,
    });

    expect(result).toMatchObject({ ok: false, code: "AREA_UNSAFE" });
    expect(manager.startBuild).not.toHaveBeenCalled();
    expect(inventoryItems).not.toHaveBeenCalled();
  });

  it("previews a wrapped BuildOps definition without exposing compiled placements", async () => {
    const placements = Array.from({ length: 4_096 }, (_, x) => ({ x, y: 0, z: 0, block: "stone" }));
    const service = {
      previewBuildDefinition: vi.fn().mockReturnValue({
        ok: true,
        value: {
          schema: "smartbot.build/v1",
          name: "large_wall",
          targetVersion: "1.21.11",
          placements,
          report: {
            operationCount: 1,
            placementCount: placements.length,
            worldCellCount: placements.length,
            bounds: { min: [0, 0, 0], max: [4_095, 0, 0] },
            materials: { stone: placements.length },
            overwrites: 0,
            punches: 0,
            warnings: [],
            diagnostics: [],
            requiredAccess: "operator",
            sourceHash: "a".repeat(64),
          },
        },
      }),
    } as any;
    const definition = {
      schema: "smartbot.build/v1",
      name: "large_wall",
      targetVersion: "1.21.11",
      ops: [{ op: "put", at: [0, 0, 0], block: "stone" }],
    };
    const result = await createPreviewBuildDefinitionTool(service, undefined).handler({ definition });
    expect(result).toMatchObject({ ok: true, details: { build: { placementCount: 4_096 } } });
    expect(JSON.stringify(result)).not.toContain('"placements"');
    expect(service.previewBuildDefinition).toHaveBeenCalledWith({ definition });
  });

  it("returns exact bounded live-site counts and a sample only", async () => {
    const service = {
      previewBuildDefinition: vi.fn().mockReturnValue({
        ok: true,
        value: {
          schema: "smartbot.build/v1",
          name: "wall",
          targetVersion: "1.21.11",
          placements: Array.from({ length: 64 }, (_, x) => ({ x, y: 0, z: 0, block: "stone" })),
          report: {
            operationCount: 1, placementCount: 64, worldCellCount: 64,
            bounds: { min: [0, 0, 0], max: [63, 0, 0] }, materials: { stone: 64 },
            overwrites: 0, punches: 0, warnings: [], diagnostics: [], requiredAccess: "operator", sourceHash: "a".repeat(64),
          },
        },
      }),
    } as any;
    const bot = {
      blockAt: (position: { x: number; y: number }) => position.y === -1
        ? { name: "stone", boundingBox: "block" }
        : { name: "chest", boundingBox: "block" },
    } as any;
    const result = await createPreviewBuildDefinitionTool(service, bot).handler({
      definition: {
        schema: "smartbot.build/v1", name: "wall", targetVersion: "1.21.11",
        ops: [{ op: "put", at: [0, 0, 0], block: "stone" }],
      },
      origin: { x: 0, y: 0, z: 0 },
    });
    expect(result.details).toMatchObject({
      site: { issueCount: 64, issueCounts: { blocked: 64 }, truncated: true },
    });
    const site = (result.details as any).site;
    expect(site.issues).toHaveLength(32);
  });

  it("registers through the dynamic actor service and preserves service safety failures", async () => {
    const service = {
      registerBuildDefinition: vi.fn().mockReturnValue({
        ok: true,
        value: {
          blueprint: { id: 7, name: "generated", blocks: [{ x: 0, y: 0, z: 0, block: "stone" }] },
          compiled: {
            schema: "smartbot.build/v1", name: "generated", targetVersion: "1.21.11", placements: [],
            report: {
              operationCount: 1, placementCount: 1, worldCellCount: 1,
              bounds: { min: [0, 0, 0], max: [0, 0, 0] }, materials: { stone: 1 },
              overwrites: 0, punches: 0, warnings: [], diagnostics: [], requiredAccess: "operator", sourceHash: "b".repeat(64),
            },
          },
        },
      }),
    } as any;
    const definition = {
      schema: "smartbot.build/v1", name: "source_name", targetVersion: "1.21.11",
      ops: [{ op: "put", at: [0, 0, 0], block: "stone" }],
    };
    const registered = await createRegisterBuildDefinitionTool(service, constructionActorProvider).handler({
      definition, name: "generated",
    });
    expect(registered).toMatchObject({ ok: true, details: { blueprint: { id: 7, blockCount: 1 } } });
    expect(service.registerBuildDefinition).toHaveBeenCalledWith({
      definition,
      creator: constructionActor,
      name: "generated",
    });

    service.registerBuildDefinition.mockReturnValueOnce({
      ok: false,
      error: { code: "PLACEMENT_HINT_UNSUPPORTED", message: "hint unsupported" },
    });
    const rejected = await createRegisterBuildDefinitionTool(service, constructionActorProvider).handler({ definition });
    expect(rejected).toMatchObject({
      ok: false,
      code: "NOT_CONFIGURED",
      details: { buildOpsCode: "PLACEMENT_HINT_UNSUPPORTED" },
    });
  });

  it("exports provider-compatible wrapped BuildOps schemas", () => {
    for (const schema of [previewBuildDefinitionSchema, registerBuildDefinitionSchema]) {
      const json = zodToJsonSchema(schema, { $refStrategy: "none" }) as any;
      expect(json.type).toBe("object");
      expect(json.properties.definition).toBeDefined();
      expect(json.properties.definition.type).not.toBe("string");
      expect(json.properties.definition.anyOf).toHaveLength(2);
      expect(JSON.stringify(json)).toContain("smartbot.build/v1");
    }
  });
});
