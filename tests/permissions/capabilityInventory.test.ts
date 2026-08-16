import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDatabase, type DB } from "../../src/memory/db.js";
import { createSayPublicTool, createSayTool, type ToolDef } from "../../src/agent/tools.js";
import { createInspectTool } from "../../src/agent/inspectTool.js";
import { createInventoryTool } from "../../src/agent/inventoryTool.js";
import { createFindBlockTool } from "../../src/agent/findBlockTool.js";
import { createRunCommandTool, createStopTool } from "../../src/agent/commandTools.js";
import { createSetFlightTool } from "../../src/agent/flightTool.js";
import {
  createRememberFactTool,
  createRememberLocationTool,
  createRecallTool,
  createSetGoalTool,
} from "../../src/agent/memoryTools.js";
import {
  createGetInventoryPolicyTool,
  createSetInventoryPolicyTool,
} from "../../src/agent/inventoryPolicyTools.js";
import {
  createGetTaskPlanTool,
  createManageTaskPlanTool,
  createTaskPlanTool,
} from "../../src/agent/taskTools.js";
import {
  createGetSupplyGoalTool,
  createManageSupplyGoalTool,
  createStandingSupplyGoalTool,
} from "../../src/agent/supplyGoalTools.js";
import {
  createGetFarmTool,
  createManageFarmTool,
  createRegisterFarmTool,
} from "../../src/agent/farmTools.js";
import {
  createGetBlueprintTool,
  createGetConstructionTool,
  createListBlueprintsTool,
  createManageConstructionTool,
  createPreviewBuildDefinitionTool,
  createRegisterBlueprintTool,
  createRegisterBuildDefinitionTool,
  createStartConstructionTool,
} from "../../src/agent/constructionTools.js";
import {
  createGetMissionRunTool,
  createGetMissionTool,
  createListMissionsTool,
  createManageMissionRunTool,
  createPreviewMissionTool,
  createRunMissionTool,
  createSaveMissionTool,
  createValidateMissionTool,
} from "../../src/agent/missionTools.js";
import {
  createQueryWorldMapTool,
  createStartSurveyTool,
} from "../../src/agent/explorationTools.js";
import {
  createGetPlayerRolesTool,
  createSetPlayerRoleTool,
} from "../../src/agent/roleTools.js";
import {
  createGetNotificationRulesTool,
  createGetRecentEventsTool,
  createSetNotificationRuleTool,
} from "../../src/agent/eventTools.js";
import { createSkillTool } from "../../src/agent/skillTools.js";
import {
  createGetWorldTransactionTool,
  createListWorldTransactionsTool,
  createPreviewUndoTransactionTool,
  createUndoWorldTransactionTool,
} from "../../src/agent/transactionTools.js";
import { authorizeTool } from "../../src/permissions/toolAuthorization.js";
import { createRuntimeSkillDefinitions } from "../../src/runtime/connection.js";

let tempDir: string | undefined;
let db: DB | undefined;

afterEach(() => {
  db?.close();
  db = undefined;
  if (tempDir) rmSync(tempDir, { recursive: true, force: true });
  tempDir = undefined;
});

function createDatabase(): DB {
  tempDir = mkdtempSync(join(tmpdir(), "smartbotmc-capability-inventory-"));
  db = openDatabase(join(tempDir, "memory.sqlite"));
  return db;
}

describe("production capability inventory", () => {
  it("registers policy for every direct tool factory and runtime skill", () => {
    const database = createDatabase();
    const fake = {} as never;
    const ownerActor = {
      username: "owner",
      role: "owner" as const,
      source: "minecraft-chat" as const,
    };
    const ownerActorProvider = () => ownerActor;
    const missionService = {} as never;
    const tools: ToolDef<unknown>[] = [
      createSayTool(() => {}, () => {}),
      createSayPublicTool(() => {}, () => {}),
      createInspectTool(fake, "owner"),
      createInventoryTool(fake),
      createFindBlockTool(fake),
      createRunCommandTool(async () => []),
      createStopTool(fake),
      createSetFlightTool(fake, async () => []),
      createRememberFactTool(database, () => "minecraft-chat"),
      createRememberLocationTool(database),
      createRecallTool(database),
      createSetGoalTool(database),
      createSetInventoryPolicyTool(database),
      createGetInventoryPolicyTool(database),
      createTaskPlanTool(fake, ownerActorProvider),
      createGetTaskPlanTool(fake),
      createManageTaskPlanTool(fake),
      createStandingSupplyGoalTool(fake),
      createGetSupplyGoalTool(fake),
      createManageSupplyGoalTool(fake),
      createRegisterFarmTool(fake),
      createGetFarmTool(fake),
      createManageFarmTool(fake),
      createRegisterBlueprintTool(fake),
      createPreviewBuildDefinitionTool(fake, fake),
      createRegisterBuildDefinitionTool(fake, ownerActorProvider),
      createListBlueprintsTool(fake),
      createGetBlueprintTool(fake),
      createStartConstructionTool(fake, fake, ownerActorProvider),
      createGetConstructionTool(fake),
      createManageConstructionTool(fake, ownerActorProvider),
      createValidateMissionTool(missionService, ownerActorProvider),
      createPreviewMissionTool(missionService, ownerActorProvider),
      createSaveMissionTool(missionService, ownerActorProvider),
      createListMissionsTool(missionService),
      createGetMissionTool(missionService),
      createRunMissionTool(missionService, ownerActorProvider),
      createGetMissionRunTool(missionService),
      createManageMissionRunTool(missionService, ownerActorProvider),
      createStartSurveyTool(fake, ownerActorProvider),
      createQueryWorldMapTool(database, "test:25565"),
      createSetPlayerRoleTool(database, "owner"),
      createGetPlayerRolesTool(database, "owner"),
      createGetRecentEventsTool(database),
      createSetNotificationRuleTool(database),
      createGetNotificationRulesTool(database),
      createListWorldTransactionsTool({
        transactions: fake,
        serverKey: "test:25565",
        getBot: () => fake,
        actorProvider: ownerActorProvider,
      }),
      createGetWorldTransactionTool({
        transactions: fake,
        serverKey: "test:25565",
        getBot: () => fake,
        actorProvider: ownerActorProvider,
      }),
      createPreviewUndoTransactionTool({
        transactions: fake,
        serverKey: "test:25565",
        getBot: () => fake,
        actorProvider: ownerActorProvider,
      }),
      createUndoWorldTransactionTool({
        transactions: fake,
        serverKey: "test:25565",
        getBot: () => fake,
        actorProvider: ownerActorProvider,
      }),
    ] as ToolDef<unknown>[];
    const skills = createRuntimeSkillDefinitions({
      db: database,
      serverKey: "test:25565",
      transactions: fake,
      ownerUsername: "owner",
      configuredVersion: "1.21.11",
      getLiveVersion: () => "1.21.11",
    });

    expect(tools).toHaveLength(50);
    expect(skills).toHaveLength(38);
    expect(new Set(tools.map((tool) => tool.name)).size).toBe(tools.length);
    expect(new Set(skills.map((skill) => skill.name)).size).toBe(skills.length);

    const registeredTools = tools.map((tool) => authorizeTool(tool, {
      username: "owner",
      role: "owner",
      source: "minecraft-chat",
    }));
    const adaptedSkills = skills.map((skill) => createSkillTool(skill, fake, ownerActorProvider));
    for (const capability of [...registeredTools, ...adaptedSkills]) {
      expect(capability.policy.minimumRole).toMatch(/^(viewer|operator|owner)$/);
      expect(capability.policy.effect).toMatch(/^(read|communicate|inventory|world-change|destructive|administrative)$/);
      expect(["public", "internal", "forbidden"]).toContain(capability.policy.mission);
      expect(Object.isFrozen(capability.policy)).toBe(true);
    }
  });
});
