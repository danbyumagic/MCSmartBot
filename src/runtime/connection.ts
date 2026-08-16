import type { Config } from "../config.js";
import type { ServerConfig } from "../config/serverConfig.js";
import type {
  AppJsonValue,
  MissionDTO,
  MissionRunDTO,
  MissionRunSummaryDTO,
  MissionSaveInput,
  MissionSummaryDTO,
  MissionValidationDTO,
  TransactionListInput,
  UndoPreviewDTO,
  WorldTransactionDTO,
  WorldTransactionSummaryDTO,
} from "../app/contracts.js";
import type { MissionRunStatus } from "../missions/types.js";
import {
  missionDetail,
  missionPreview,
  missionRunDetail,
  missionRunSummary,
  missionSummary,
  missionValidation,
  toJsonRecord,
  transactionDetail,
  transactionSummary,
  undoPreview,
} from "../app/data.js";
import minecraftData from "minecraft-data";
import type { DB } from "../memory/db.js";
import type { Logger } from "../util/logger.js";
import type { MicrosoftAuthPrompt } from "../app/contracts.js";
import { createBus } from "../bus/index.js";
import { appendConversation } from "../memory/conversations.js";
import { createBotClient } from "../bot/client.js";
import { wireBotEvents } from "../bot/events.js";
import { wireChatSurface } from "../bot/chatSurface.js";
import { wireChatMirror } from "../bot/chatMirror.js";
import { parseChatLine, parseWhisperLine } from "../bot/chatPatterns.js";
import { createSendQueue } from "../bot/sendQueue.js";
import { wireTpAutoAccept } from "../bot/tpRequests.js";
import { createSayTool, createSayPublicTool, type ToolDef } from "../agent/tools.js";
import { createInspectTool } from "../agent/inspectTool.js";
import { createInventoryTool } from "../agent/inventoryTool.js";
import { createFindBlockTool } from "../agent/findBlockTool.js";
import { createRunCommandTool, createStopTool } from "../agent/commandTools.js";
import { createSetFlightTool } from "../agent/flightTool.js";
import { createAgentSession } from "../agent/session.js";
import { createTriggerQueue } from "../agent/triggerQueue.js";
import { createTriggerSourceState } from "../agent/triggerSource.js";
import { startIdleTicker, bumpActivity } from "../agent/idleTick.js";
import {
  createRememberFactTool,
  createRememberLocationTool,
  createRecallTool,
  createSetGoalTool,
} from "../agent/memoryTools.js";
import {
  createGetInventoryPolicyTool,
  createSetInventoryPolicyTool,
} from "../agent/inventoryPolicyTools.js";
import {
  createGetTaskPlanTool,
  createManageTaskPlanTool,
  createTaskPlanTool,
} from "../agent/taskTools.js";
import {
  createGetSupplyGoalTool,
  createManageSupplyGoalTool,
  createStandingSupplyGoalTool,
} from "../agent/supplyGoalTools.js";
import { createSkillTool } from "../agent/skillTools.js";
import { createSkillRegistry } from "../skills/registry.js";
import { createSkillRunner } from "../skills/runner.js";
import { gotoCoords } from "../skills/navigation/gotoCoords.js";
import { gotoPlayer } from "../skills/navigation/gotoPlayer.js";
import { returnToBase } from "../skills/navigation/returnToBase.js";
import { followPlayer } from "../skills/navigation/followPlayer.js";
import { mineUntil } from "../skills/resources/mineUntil.js";
import { chopTrees } from "../skills/resources/chopTrees.js";
import { pickupNearby } from "../skills/resources/pickupNearby.js";
import { chestDeposit } from "../skills/resources/chestDeposit.js";
import { scanContainer } from "../skills/resources/scanContainer.js";
import { retrieveItem } from "../skills/resources/retrieveItem.js";
import { restockInventory } from "../skills/resources/restockInventory.js";
import { supplyContainer } from "../skills/resources/supplyContainer.js";
import { craftItem } from "../skills/items/craftItem.js";
import { equipBestTool } from "../skills/items/equipBestTool.js";
import { equipArmor } from "../skills/items/equipArmor.js";
import { equipItem } from "../skills/items/equipItem.js";
import { smeltItem } from "../skills/items/smeltItem.js";
import { ensureTool } from "../skills/items/ensureTool.js";
import { tossItem } from "../skills/items/tossItem.js";
import { consumeItem } from "../skills/items/consumeItem.js";
import { createPlaceBlockSkill } from "../skills/world/placeBlock.js";
import { createDigBlockSkill } from "../skills/world/digBlock.js";
import { createClearRegionSkill } from "../skills/world/clearRegion.js";
import { activateBlock } from "../skills/world/activateBlock.js";
import { sleep } from "../skills/interaction/sleep.js";
import { activateEntity } from "../skills/interaction/activateEntity.js";
import { openVillager } from "../skills/interaction/openVillager.js";
import { tradeVillager } from "../skills/interaction/tradeVillager.js";
import { inspectWindow } from "../skills/interaction/inspectWindow.js";
import { clickWindowSlot } from "../skills/interaction/clickWindowSlot.js";
import { closeWindow } from "../skills/interaction/closeWindow.js";
import { harvestFarm } from "../skills/farming/harvestFarm.js";
import { buildBlueprint } from "../skills/construction/buildBlueprint.js";
import { prepareBlueprintMaterials } from "../skills/construction/prepareBlueprintMaterials.js";
import { surveyArea } from "../skills/exploration/surveyArea.js";
import { createTaskEngine } from "../tasks/engine.js";
import { createSupplyScheduler } from "../supply/scheduler.js";
import { createFarmScheduler } from "../farming/scheduler.js";
import {
  createGetFarmTool,
  createManageFarmTool,
  createRegisterFarmTool,
} from "../agent/farmTools.js";
import { createConstructionManager } from "../construction/manager.js";
import { createBuildOpsService } from "../construction/buildOps/service.js";
import { createBuildBlockRegistry } from "../construction/buildOps/blockRegistry.js";
import type { BuildBlockRegistry } from "../construction/buildOps/types.js";
import { createMissionService } from "../missions/service.js";
import {
  createGetBlueprintTool,
  createGetConstructionTool,
  createListBlueprintsTool,
  createManageConstructionTool,
  createPreviewBuildDefinitionTool,
  createRegisterBlueprintTool,
  createRegisterBuildDefinitionTool,
  createStartConstructionTool,
} from "../agent/constructionTools.js";
import {
  createGetMissionRunTool,
  createGetMissionTool,
  createListMissionsTool,
  createManageMissionRunTool,
  createPreviewMissionTool,
  createRunMissionTool,
  createSaveMissionTool,
  createValidateMissionTool,
} from "../agent/missionTools.js";
import { installBuiltInBlueprints } from "../construction/builtins.js";
import {
  createQueryWorldMapTool,
  createStartSurveyTool,
} from "../agent/explorationTools.js";
import {
  createGetPlayerRolesTool,
  createSetPlayerRoleTool,
} from "../agent/roleTools.js";
import {
  resolvePlayerRole,
  type ActorContext,
  type AssignableRole,
} from "../permissions/roles.js";
import { authorizeTool } from "../permissions/toolAuthorization.js";
import {
  snapshotExecutionActor,
  snapshotSkillExecutionContext,
  systemActor,
} from "../permissions/executionActor.js";
import { createEventService } from "../events/service.js";
import {
  createGetNotificationRulesTool,
  createGetRecentEventsTool,
  createSetNotificationRuleTool,
} from "../agent/eventTools.js";
import { createReflexRegistry } from "../reactive/registry.js";
import { createPreemptController } from "../reactive/preempt.js";
import { meleeDefense } from "../reactive/reflexes/meleeDefense.js";
import { fleeOnLowHp } from "../reactive/reflexes/fleeOnLowHp.js";
import { avoidLava } from "../reactive/reflexes/avoidLava.js";
import { autoEat } from "../reactive/reflexes/autoEat.js";
import {
  createInventorySnapshot,
  formatInventoryContext,
} from "../inventory/snapshot.js";
import type { BotRuntimeState, EmergencyStopResult } from "./state.js";
import { runEmergencyStop } from "./emergencyStop.js";
import {
  createMapTrailRecorder,
  makeServerKey,
} from "../exploration/mapStore.js";
import { createTerrainRecorder } from "../exploration/terrainStore.js";
import {
  createWorldTransactionService,
  type WorldTransactionService,
} from "../world/transactions/service.js";
import { inspectJournalBlock } from "../world/transactions/runtimeInspect.js";
import {
  createGetWorldTransactionTool,
  createListWorldTransactionsTool,
  createPreviewUndoTransactionTool,
  createUndoWorldTransactionTool,
} from "../agent/transactionTools.js";
import {
  previewUndoTransaction,
  reconcileUndoingTransactions,
  undoWorldTransaction,
} from "../skills/world/undoTransaction.js";

export interface ConnectionRuntime {
  sendPublicChat(text: string): void;
  requestAgent(text: string, source?: "cli" | "desktop"): void;
  runCommand(command: string): void;
  getStatus(): string;
  getLiveState(): BotRuntimeState;
  emergencyStop(source?: string): EmergencyStopResult;
  stop(reason?: string): void;
  listMissions(input?: { enabled?: boolean; limit?: number }): MissionSummaryDTO[];
  getMission(id: number): MissionDTO | undefined;
  listMissionRuns(input?: { definitionId?: number; taskPlanId?: number; status?: string; limit?: number }): MissionRunSummaryDTO[];
  getMissionRun(id: number): MissionRunDTO | undefined;
  listWorldTransactions(input?: TransactionListInput): WorldTransactionSummaryDTO[];
  getWorldTransaction(id: number): WorldTransactionDTO | undefined;
  validateMission(definition: { readonly [key: string]: AppJsonValue }): MissionValidationDTO;
  previewMission(definition: { readonly [key: string]: AppJsonValue }): MissionValidationDTO;
  saveMission(input: MissionSaveInput): MissionDTO;
  runMission(input: { definitionId?: number; definition?: { readonly [key: string]: AppJsonValue } }): MissionRunDTO;
  manageMissionRun(input: { runId: number; action: "pause" | "resume" | "cancel" }): MissionRunDTO;
  previewUndoTransaction(transactionId: number): UndoPreviewDTO;
  undoWorldTransaction(input: { transactionId: number; storageName?: string }): Promise<Record<string, AppJsonValue>>;
}

export interface ConnectionRuntimeHooks {
  onReady(): void;
  onEnd(reason: string): void;
}

/**
 * Resolve only the configured Minecraft version and verify minecraft-data did
 * not silently fall back to a neighboring protocol release. A source that
 * names any other version receives a compiler VERSION_MISMATCH instead of an
 * interpreted registry from this connection.
 */
export function createConfiguredBuildRegistryResolver(
  configuredVersion: string,
): (targetVersion: string) => BuildBlockRegistry | undefined {
  let attempted = false;
  let registry: BuildBlockRegistry | undefined;
  return (targetVersion) => {
    if (targetVersion !== configuredVersion) return undefined;
    if (!attempted) {
      attempted = true;
      try {
        const candidate = createBuildBlockRegistry(minecraftData(configuredVersion));
        // minecraft-data may accept an unavailable patch version and return a
        // nearby one. Do not supply a version override or reinterpret it.
        registry = candidate.version === configuredVersion ? candidate : undefined;
      } catch {
        registry = undefined;
      }
    }
    return registry;
  };
}

/**
 * The one runtime skill inventory. Keeping this separate from connection
 * startup lets the policy inventory test exercise the exact list that becomes
 * direct agent tools and durable-plan steps, rather than a hand-maintained
 * duplicate.
 */
export function createRuntimeSkillDefinitions(deps: {
  db: DB;
  serverKey: string;
  transactions: WorldTransactionService;
  /** Required by source-backed construction reauthorization at click time. */
  ownerUsername: string;
  /** Required to reject a compiled source for a neighboring Minecraft patch. */
  configuredVersion: string;
  /** Read at source-backed execution boundaries; never substitute configuration. */
  getLiveVersion: () => string | undefined;
}) {
  const {
    db,
    serverKey,
    transactions,
    ownerUsername,
    configuredVersion,
    getLiveVersion,
  } = deps;
  return [
    gotoCoords,
    gotoPlayer,
    returnToBase(db),
    followPlayer,
    mineUntil,
    chopTrees,
    pickupNearby,
    chestDeposit(db),
    craftItem,
    equipBestTool,
    equipArmor,
    equipItem,
    smeltItem,
    ensureTool,
    tossItem,
    consumeItem,
    createPlaceBlockSkill({ transactions, serverKey }),
    createDigBlockSkill({ transactions, serverKey }),
    createClearRegionSkill({ transactions, serverKey }),
    activateBlock,
    sleep,
    activateEntity,
    openVillager,
    tradeVillager,
    inspectWindow,
    clickWindowSlot,
    closeWindow,
    scanContainer(db),
    retrieveItem(db),
    restockInventory(db),
    supplyContainer(db),
    harvestFarm(db),
    prepareBlueprintMaterials({ db, ownerUsername, configuredVersion, getLiveVersion }),
    buildBlueprint({
      db,
      transactions,
      serverKey,
      ownerUsername,
      configuredVersion,
      getLiveVersion,
    }),
    surveyArea(db, serverKey),
  ];
}

export function createConnectionRuntime(deps: {
  cfg: Config;
  serverConfig: ServerConfig;
  db: DB;
  log: Logger;
  hooks: ConnectionRuntimeHooks;
  claudeCodeExecutable?: string;
  codexExecutable?: string;
  agentApiKey?: string;
  agentModel?: string;
  agentBaseUrl?: string;
  agentHttpReferer?: string;
  workingDirectory?: string;
  onMicrosoftAuth?: (prompt: MicrosoftAuthPrompt) => void;
}): ConnectionRuntime {
  const { cfg, db, log, serverConfig } = deps;
  const serverKey = makeServerKey(cfg.serverHost, cfg.serverPort);
  const mapTrail = createMapTrailRecorder(db, serverKey);
  const bus = createBus();
  const handle = createBotClient(cfg, log.child({ component: "bot" }), {
    onMicrosoftAuth: deps.onMicrosoftAuth,
  });
  const terrainRecorder = createTerrainRecorder({ bot: handle.bot, db, serverKey });
  const worldTransactions = createWorldTransactionService({ db });
  const buildOpsService = createBuildOpsService({
    db,
    registryForVersion: createConfiguredBuildRegistryResolver(cfg.serverVersion),
  });
  // This is intentionally mutable for the agent session only. Every capability
  // that starts asynchronous work snapshots it at its own boundary.
  const actorContext: ActorContext = {
    username: cfg.ownerUsername,
    role: "owner",
    source: "cli",
  };
  const currentExecutionActor = () => snapshotExecutionActor(actorContext);
  // BuildOps source execution must observe the connected client's own exact
  // version. Never fall back to the configured profile: that would turn a
  // minecraft-data compatibility fallback into an executable source mismatch.
  const getLiveMinecraftVersion = (): string | undefined => {
    const version = (handle.bot as unknown as { version?: unknown }).version;
    return typeof version === "string" && version.trim().length > 0
      ? version.trim()
      : undefined;
  };
  wireBotEvents(handle.bot, bus, log.child({ component: "bot" }), cfg.ownerUsername);
  if (cfg.chatMirrorEnabled) {
    wireChatMirror({ bot: handle.bot });
  }

  const skillRegistry = createSkillRegistry(createRuntimeSkillDefinitions({
    db,
    serverKey,
    transactions: worldTransactions,
    ownerUsername: cfg.ownerUsername,
    configuredVersion: cfg.serverVersion,
    getLiveVersion: getLiveMinecraftVersion,
  }));
  const skillRunner = createSkillRunner({
    bot: handle.bot,
    log: log.child({ component: "skill" }),
    defaultExecution: snapshotSkillExecutionContext({
      actor: systemActor(cfg.ownerUsername, "recovery"),
    }),
    db,
    bus,
  });
  const taskEngine = createTaskEngine({
    db,
    log: log.child({ component: "tasks" }),
    bus,
    registry: skillRegistry,
    runner: skillRunner,
    ownerUsername: cfg.ownerUsername,
  });
  const supplyScheduler = createSupplyScheduler({
    db,
    bus,
    log: log.child({ component: "supply" }),
    tasks: taskEngine,
    ownerUsername: cfg.ownerUsername,
  });
  const farmScheduler = createFarmScheduler({
    db,
    bus,
    log: log.child({ component: "farming" }),
    tasks: taskEngine,
    ownerUsername: cfg.ownerUsername,
  });
  const constructionManager = createConstructionManager({
    db,
    bus,
    log: log.child({ component: "construction" }),
    tasks: taskEngine,
    ownerUsername: cfg.ownerUsername,
    configuredVersion: cfg.serverVersion,
    // Do not substitute the configured profile here: a source-backed build
    // must see the connected client's exact reported version before it can
    // enqueue material preparation or a construction task.
    getLiveVersion: getLiveMinecraftVersion,
  });
  const missionService = createMissionService({
    db,
    bus,
    log: log.child({ component: "missions" }),
    registry: skillRegistry,
    tasks: taskEngine,
    construction: constructionManager,
    ownerUsername: cfg.ownerUsername,
    registryForVersion: createConfiguredBuildRegistryResolver(cfg.serverVersion),
    getLiveDimension: () => {
      const dimension = handle.bot.game?.dimension;
      return typeof dimension === "string" && dimension.trim().length > 0
        ? dimension.trim()
        : undefined;
    },
    getLiveBot: () => handle.bot,
  });
  const installedBlueprints = installBuiltInBlueprints(constructionManager);
  if (installedBlueprints.length > 0) {
    log.info(
      { blueprints: installedBlueprints.map((blueprint) => blueprint.name) },
      "installed built-in blueprints",
    );
  }
  constructionManager.start();
  missionService.start();
  const reflexRegistry = createReflexRegistry([
    meleeDefense,
    fleeOnLowHp({
      db,
      ownerUsername: cfg.ownerUsername,
      hpThreshold: cfg.hpFleeThreshold,
    }),
    avoidLava,
    autoEat({ foodThreshold: cfg.foodEatThreshold }),
  ]);
  const preempt = createPreemptController({
    bot: handle.bot,
    log: log.child({ component: "reactive" }),
    registry: reflexRegistry,
    runner: skillRunner,
    bus,
    alertingReflexes: new Set(["fleeOnLowHp", "avoidLava"]),
  });
  const sendQueue = createSendQueue(handle.bot, { minIntervalMs: 1000 });

  let servicesStarted = false;
  let physicsWired = false;
  let joinCommandSent = false;
  handle.bot.on("spawn", () => {
    terrainRecorder.start();
    if (!joinCommandSent && cfg.joinCommand) {
      joinCommandSent = true;
      void sendQueue.send(`/${cfg.joinCommand}`).then(
        () => log.info({ command: `/${cfg.joinCommand}` }, "executed configured join command"),
        (err) => {
          joinCommandSent = false;
          log.warn({ err, command: `/${cfg.joinCommand}` }, "configured join command failed");
        },
      );
    }
    if (!physicsWired) {
      physicsWired = true;
      handle.bot.on("physicsTick", () => {
        preempt.tick();
        const position = handle.bot.entity?.position;
        if (position) {
          mapTrail.capture({
            dimension: handle.bot.game?.dimension ?? "unknown",
            x: position.x,
            y: position.y,
            z: position.z,
          });
        }
      });
    }
    const dimension = handle.bot.game?.dimension;
    if (!dimension) {
      log.warn("durable execution is waiting for a known dimension before transaction reconciliation");
      return;
    }
    let applied = 0;
    let failed = 0;
    let conflicts = 0;
    let unavailable = 0;
    let finalized = 0;
    try {
      let afterTransactionId: number | undefined;
      do {
        const reconciliation = worldTransactions.reconcileLive({
          serverKey,
          dimension,
          afterTransactionId,
          inspect: (position) => inspectJournalBlock(handle.bot, position),
        });
        applied += reconciliation.applied;
        failed += reconciliation.failed;
        conflicts += reconciliation.conflicts;
        unavailable += reconciliation.unavailable;
        finalized += reconciliation.finalized;
        afterTransactionId = reconciliation.nextTransactionId ?? undefined;
      } while (afterTransactionId !== undefined);
    } catch (error) {
      log.error({ error, serverKey, dimension }, "world transaction reconciliation failed; durable work remains paused");
      return;
    }
    try {
      const undoReconciliation = reconcileUndoingTransactions({
        transactions: worldTransactions,
        serverKey,
        dimension,
        inspect: (position) => inspectJournalBlock(handle.bot, position),
      });
      if (undoReconciliation.reverted + undoReconciliation.conflicts > 0) {
        log.warn({ ...undoReconciliation, serverKey, dimension }, "reconciled interrupted world undo attempts");
      }
    } catch (error) {
      log.error({ error, serverKey, dimension }, "world undo reconciliation failed; undo remains paused");
    }
    if (applied + failed + conflicts > 0) {
      log.warn(
        { applied, failed, conflicts, unavailable, finalized, serverKey, dimension },
        "reconciled uncertain world transactions",
      );
    }
    if (!servicesStarted) {
      servicesStarted = true;
      taskEngine.start();
    } else {
      taskEngine.resumeExecution();
    }
    supplyScheduler.start();
    farmScheduler.start();
    deps.hooks.onReady();
    log.info("reactive and durable layers active");
  });
  handle.bot.on("death", () => {
    taskEngine.suspend();
    supplyScheduler.stop();
    farmScheduler.stop();
    skillRunner.cancel();
    log.warn("durable execution suspended until respawn");
  });

  const skillTools: ToolDef<any>[] = skillRegistry.all()
    .map((skill) => createSkillTool(skill, skillRunner, currentExecutionActor));
  const whisperTo = (user: string, text: string) =>
    sendQueue.send(`/msg ${user} ${text}`);
  const sayToRequester = (text: string) =>
    sendQueue.send(`/msg ${actorContext.username} ${text}`);
  const eventService = createEventService({
    db,
    bus,
    log: log.child({ component: "events" }),
    notifyOwner: (message) => {
      void sendQueue.send(`/msg ${cfg.ownerUsername} ${message}`);
    },
  });
  eventService.start();
  const runCommandRaw = (command: string): void => {
    void sendQueue.send(`/${command}`);
  };
  const runCommandWithOutput = async (command: string): Promise<string[]> => {
    const captured: string[] = [];
    const listener = (text: string): void => {
      if (parseChatLine(text) || parseWhisperLine(text)) return;
      captured.push(text);
    };
    handle.bot.on("messagestr", listener);
    try {
      await sendQueue.send(`/${command}`);
      await new Promise<void>((resolve) => setTimeout(resolve, 750));
    } finally {
      handle.bot.removeListener("messagestr", listener);
    }
    return captured;
  };
  const recordBotReply = (text: string) => {
    appendConversation(db, { speaker: "bot", text, channel: "chat" });
  };

  wireTpAutoAccept({
    bot: handle.bot,
    log: log.child({ component: "tpa" }),
    ownerUsername: cfg.ownerUsername,
    runCommand: runCommandRaw,
  });

  const sendPublicChat = serverConfig.publicChatCommand
    ? (text: string) => { void sendQueue.send(`/${serverConfig.publicChatCommand} ${text}`); }
    : (text: string) => { void sendQueue.send(text); };
  const triggerSource = createTriggerSourceState();
  const memoryTools: ToolDef<any>[] = [
    createRememberFactTool(db, () => triggerSource.current),
    createRememberLocationTool(db),
    createRecallTool(db),
    createSetGoalTool(db),
  ];
  const pauseActivePlan = () => {
    const planId = taskEngine.activePlanId();
    if (planId === null) return undefined;
    const paused = taskEngine.pause(planId);
    const construction = paused
      ? constructionManager.pauseByPlan(planId)
      : undefined;
    if (paused) missionService.reconcile();
    return {
      planId,
      paused,
      constructionJobId: construction?.id,
    };
  };
  const emergencyStop = (source = "unknown"): EmergencyStopResult =>
    runEmergencyStop({
      source,
      activeSkill: () => skillRunner.activeName(),
      clearTriggers: () => triggerQueue.clear(),
      cancelAgent: () => agent.cancelCurrent(),
      cancelPreempt: () => preempt.cancel(),
      cancelSkills: () => skillRunner.cancel(),
      pauseActivePlan: () => pauseActivePlan(),
      bot: handle.bot,
      log,
    });
  const unguardedTools: ToolDef<any>[] = [
    createSayTool(sayToRequester, recordBotReply),
    createSayPublicTool(sendPublicChat, recordBotReply),
    createInspectTool(handle.bot, cfg.ownerUsername),
    createInventoryTool(handle.bot),
    createFindBlockTool(handle.bot),
    createRunCommandTool(runCommandWithOutput),
    createStopTool(skillRunner, pauseActivePlan),
    createSetFlightTool(handle.bot, runCommandWithOutput),
    createSetInventoryPolicyTool(db),
    createGetInventoryPolicyTool(db),
    createTaskPlanTool(taskEngine, currentExecutionActor),
    createGetTaskPlanTool(taskEngine),
    createManageTaskPlanTool(taskEngine),
    createStandingSupplyGoalTool(supplyScheduler),
    createGetSupplyGoalTool(supplyScheduler),
    createManageSupplyGoalTool(supplyScheduler),
    createRegisterFarmTool(farmScheduler),
    createGetFarmTool(farmScheduler),
    createManageFarmTool(farmScheduler),
    createRegisterBlueprintTool(constructionManager),
    createPreviewBuildDefinitionTool(buildOpsService, handle.bot),
    createRegisterBuildDefinitionTool(buildOpsService, currentExecutionActor),
    createListBlueprintsTool(constructionManager),
    createGetBlueprintTool(constructionManager),
    createStartConstructionTool(constructionManager, handle.bot, currentExecutionActor),
    createGetConstructionTool(constructionManager),
    createManageConstructionTool(constructionManager, currentExecutionActor),
    createValidateMissionTool(missionService, currentExecutionActor),
    createPreviewMissionTool(missionService, currentExecutionActor),
    createSaveMissionTool(missionService, currentExecutionActor),
    createListMissionsTool(missionService),
    createGetMissionTool(missionService),
    createRunMissionTool(missionService, currentExecutionActor),
    createGetMissionRunTool(missionService),
    createManageMissionRunTool(missionService, currentExecutionActor),
    createListWorldTransactionsTool({
      transactions: worldTransactions,
      serverKey,
      getBot: () => handle.bot,
      actorProvider: currentExecutionActor,
    }),
    createGetWorldTransactionTool({
      transactions: worldTransactions,
      serverKey,
      getBot: () => handle.bot,
      actorProvider: currentExecutionActor,
    }),
    createPreviewUndoTransactionTool({
      transactions: worldTransactions,
      serverKey,
      getBot: () => handle.bot,
      actorProvider: currentExecutionActor,
    }),
    createUndoWorldTransactionTool({
      transactions: worldTransactions,
      serverKey,
      getBot: () => handle.bot,
      actorProvider: currentExecutionActor,
    }),
    createStartSurveyTool(taskEngine, currentExecutionActor),
    createQueryWorldMapTool(db, serverKey),
    createSetPlayerRoleTool(db, cfg.ownerUsername),
    createGetPlayerRolesTool(db, cfg.ownerUsername),
    createGetRecentEventsTool(db),
    createSetNotificationRuleTool(db),
    createGetNotificationRulesTool(db),
    ...skillTools,
    ...memoryTools,
  ];
  const guardedTools = unguardedTools.map((tool) =>
    authorizeTool(tool, actorContext));
  const agent = createAgentSession({
    log: log.child({ component: "agent" }),
    db,
    ownerUsername: cfg.ownerUsername,
    tools: guardedTools,
    triggerSource,
    serverConfig,
    agentProvider: cfg.agentProvider,
    claudeCodeExecutable: deps.claudeCodeExecutable,
    codexExecutable: deps.codexExecutable,
    agentApiKey: deps.agentApiKey,
    agentModel: deps.agentModel,
    agentBaseUrl: deps.agentBaseUrl,
    agentHttpReferer: deps.agentHttpReferer,
    workingDirectory: deps.workingDirectory,
    actorContext,
    resolveRole: (username) => resolvePlayerRole(db, username, cfg.ownerUsername),
    runtimeContext: () => {
      const bot = handle.bot;
      const inventory = formatInventoryContext(createInventorySnapshot(bot));
      if (!bot.entity) return `connection=connecting | ${inventory}`;
      const position = bot.entity.position;
      return (
        `health=${bot.health ?? 0} food=${bot.food ?? 0} ` +
        `position=${position.x.toFixed(1)},${position.y.toFixed(1)},${position.z.toFixed(1)} ` +
        `dimension=${bot.game?.dimension ?? "unknown"} ` +
        `active_skill=${skillRunner.activeName() ?? "none"} | ${inventory}`
      );
    },
  });
  const triggerQueue = createTriggerQueue({
    log: log.child({ component: "trigger" }),
  });
  wireChatSurface({
    bus,
    db,
    log: log.child({ component: "chat" }),
    ownerUsername: cfg.ownerUsername,
    botUsername: () => handle.bot.username ?? cfg.botUsername,
    whisperTo,
    roleFor: (username): AssignableRole | undefined => {
      const role = resolvePlayerRole(db, username, cfg.ownerUsername);
      return role === "operator" || role === "viewer" ? role : undefined;
    },
    onForceStop: ({ from }) => {
      emergencyStop(from);
      void whisperTo(from, "stopped");
    },
  });
  bus.on("agent.trigger", (trigger) => {
    if (trigger.kind === "cli") {
      appendConversation(db, {
        speaker: cfg.ownerUsername,
        text: trigger.text,
        channel: "cli",
      });
    }
    triggerQueue.enqueue(async () => {
      try {
        await agent.handleTrigger(trigger);
      } catch (err) {
        log.error({ err }, "agent trigger failed");
      }
    });
  });
  const lastActivity = { value: Date.now() };
  bus.on("agent.trigger", () => bumpActivity(lastActivity));
  const idleTicker = startIdleTicker({
    db,
    bus,
    log: log.child({ component: "idle" }),
    runner: skillRunner,
    intervalMinutes: cfg.agentIdleTickMinutes,
    lastActivityAt: lastActivity,
  });

  let disposed = false;
  function dispose(disconnect: boolean, reason: string): void {
    if (disposed) return;
    disposed = true;
    sendQueue.close();
    skillRunner.cancel();
    idleTicker.stop();
    supplyScheduler.stop();
    farmScheduler.stop();
    constructionManager.stop();
    missionService.stop();
    terrainRecorder.stop();
    eventService.stop();
    taskEngine.stop();
    agent.close();
    if (disconnect) handle.disconnect(reason);
  }
  bus.on("bot.end", ({ reason }) => {
    if (disposed) return;
    dispose(false, reason);
    deps.hooks.onEnd(reason);
  });

  const getLiveState = (): BotRuntimeState => {
    const bot = handle.bot;
    const position = bot.entity?.position;
    return {
      connection: position ? "connected" : "connecting",
      activeSkill: skillRunner.activeName() ?? null,
      health: bot.entity ? bot.health ?? 0 : null,
      food: bot.entity ? bot.food ?? 0 : null,
      dimension: bot.game?.dimension ?? null,
      position: position
        ? { x: position.x, y: position.y, z: position.z }
        : null,
      inventory: createInventorySnapshot(bot),
    };
  };

  return {
    sendPublicChat,
    requestAgent: (text, source = "cli") => {
      bus.emit("agent.trigger", { kind: "cli", text, executionSource: source });
    },
    runCommand: runCommandRaw,
    getStatus: () => {
      const live = getLiveState();
      if (!live.position) return live.connection;
      const p = live.position;
      return `hp=${live.health ?? 0} food=${live.food ?? 0} pos=${p.x.toFixed(1)},${p.y.toFixed(1)},${p.z.toFixed(1)}`;
    },
    getLiveState,
    emergencyStop,
    stop: (reason = "shutdown") => dispose(true, reason),
    listMissions: (input) => createMissionSummaryList(missionService.listDefinitions(input)),
    getMission: (id) => {
      const result = missionService.getDefinition(id);
      return result ? missionDetail(result) : undefined;
    },
    listMissionRuns: (input) => missionService.listRuns(input === undefined ? undefined : {
      ...(input.definitionId === undefined ? {} : { definitionId: input.definitionId }),
      ...(input.taskPlanId === undefined ? {} : { taskPlanId: input.taskPlanId }),
      ...(input.status === undefined ? {} : { status: input.status as MissionRunStatus }),
      ...(input.limit === undefined ? {} : { limit: input.limit }),
    }).map(missionRunSummary),
    getMissionRun: (id) => {
      const result = missionService.getRun(id);
      return result ? missionRunDetail(result) : undefined;
    },
    listWorldTransactions: (input) => transactionsList(worldTransactions.list({
      serverKey,
      ...(input?.dimension === undefined ? {} : { dimension: input.dimension }),
      ...(input?.status === undefined ? {} : { status: input.status as never }),
      ...(input?.limit === undefined ? {} : { limit: input.limit }),
    })),
    getWorldTransaction: (id) => {
      const result = worldTransactions.get(id);
      if (!result || result.serverKey !== serverKey) return undefined;
      return transactionDetail(result);
    },
    validateMission: (definition) => missionValidation(
      missionService.validate({ definition, actor: currentExecutionActor() }),
      "validate",
    ),
    previewMission: (definition) => missionValidation(
      missionService.preview({ definition, actor: currentExecutionActor() }),
      "preview",
    ),
    saveMission: (input) => {
      const result = missionService.save({ ...input, actor: currentExecutionActor() });
      if (!result.ok) throw new Error(result.error.message);
      return missionDetail(result.value);
    },
    runMission: (input) => {
      const result = missionService.run({ ...input, actor: currentExecutionActor() });
      if (!result.ok) throw new Error(result.error.message);
      return missionRunDetail(result.value.run);
    },
    manageMissionRun: (input) => {
      const result = missionService.manageRun({ ...input, actor: currentExecutionActor() });
      if (!result.ok) throw new Error(result.error.message);
      return missionRunDetail(result.value);
    },
    previewUndoTransaction: (transactionId) => {
      const result = previewUndoTransaction({
        transactions: worldTransactions,
        serverKey,
        bot: handle.bot,
      }, transactionId);
      if (isToolResult(result)) throw new Error(result.summary);
      if (!isUndoPreview(result)) throw new Error("undo preview returned an invalid response");
      return undoPreview(result);
    },
    undoWorldTransaction: async (input) => {
      const result = await undoWorldTransaction({
        transactions: worldTransactions,
        serverKey,
        bot: handle.bot,
      }, input);
      if (!result.ok) throw new Error(result.summary);
      return toJsonRecord(result.details ?? {});
    },
  };
}

function createMissionSummaryList(rows: ReturnType<import("../missions/service.js").MissionService["listDefinitions"]>): MissionSummaryDTO[] {
  return rows.map(missionSummary);
}

function transactionsList(rows: ReturnType<WorldTransactionService["list"]>): WorldTransactionSummaryDTO[] {
  return rows.map(transactionSummary);
}

function isToolResult(value: unknown): value is { ok: false; summary: string } {
  return typeof value === "object" && value !== null && "ok" in value && (value as { ok?: unknown }).ok === false;
}

function isUndoPreview(value: unknown): value is import("../skills/world/undoTransaction.js").UndoPreview {
  return typeof value === "object" && value !== null &&
    typeof (value as { transactionId?: unknown }).transactionId === "number" &&
    Array.isArray((value as { changes?: unknown }).changes);
}
