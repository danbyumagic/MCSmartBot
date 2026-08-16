import { describe, expect, it, vi } from "vitest";
import {
  createGetMissionRunTool,
  createListMissionsTool,
  createManageMissionRunTool,
  createPreviewMissionTool,
  createRunMissionTool,
  createSaveMissionTool,
  createValidateMissionTool,
} from "../../src/agent/missionTools.js";
import { authorizeTool } from "../../src/permissions/toolAuthorization.js";
import type { MissionService } from "../../src/missions/service.js";

const actor = { username: "Builder", role: "operator" as const, source: "minecraft-chat" as const };
const actorProvider = () => actor;

const definition = {
  schema: "smartbot.mission/v1" as const,
  name: "tool-test",
  limits: { maxLogicalSteps: 1, maxExpandedSteps: 1, maxWorldChanges: 1, maxRuntimeMinutes: 10 },
  steps: [{ id: "survey", op: "skill" as const, skill: "surveyArea", params: {} }],
};

function report() {
  return {
    name: "tool-test",
    logicalStepCount: 1,
    expandedStepCount: 1,
    estimatedWorldChanges: 0,
    maxExpandedSteps: 1,
    maxWorldChanges: 1,
    maxRuntimeMinutes: 10,
    requiredRole: "operator" as const,
    builds: [],
    warnings: [],
  };
}

function service(): MissionService {
  return {
    start: vi.fn(),
    stop: vi.fn(),
    reconcile: vi.fn(),
    validate: vi.fn(() => ({ ok: true, value: { definition, actor, logicalSteps: [], report: report() } })),
    preview: vi.fn(() => ({
      ok: true,
      value: {
        compilation: { definition, actor, logicalSteps: [], report: report() },
        buildSites: [],
      },
    })),
    save: vi.fn(() => ({
      ok: true,
      value: {
        id: 1, tsCreated: 1, tsUpdated: 1, name: "tool-test", schema: "smartbot.mission/v1",
        sourceJson: JSON.stringify(definition), sourceHash: "a".repeat(64), creator: { username: "Builder", source: "minecraft-chat" }, enabled: true,
        definition,
      },
    })),
    getDefinition: vi.fn(() => undefined),
    listDefinitions: vi.fn(() => [{
      id: 1, tsCreated: 1, tsUpdated: 1, name: "tool-test", schema: "smartbot.mission/v1", sourceHash: "a".repeat(64), creator: { username: "Builder", source: "minecraft-chat" }, enabled: true,
    }]),
    run: vi.fn(() => ({
      ok: true,
      value: {
        run: {
          id: 9, tsCreated: 1, tsUpdated: 1, definitionId: null, sourceSchema: "smartbot.mission/v1",
          sourceJson: JSON.stringify(definition), sourceHash: "a".repeat(64), actor,
          limits: definition.limits, compileReport: {}, taskPlanId: 5, transactionScope: "mission:9",
          transactionCorrelation: {}, deadlineAt: 100, status: "running" as const, tsStarted: 1, tsFinished: null, lastError: null, stepLinks: [],
        },
        plan: { id: 5, tsCreated: 1, tsUpdated: 1, title: "tool-test", status: "pending" as const, lastError: null, actor, actorAuthorizedAt: 1, steps: [] },
        constructionJobIds: [],
        report: report(),
      },
    })),
    getRun: vi.fn(() => undefined),
    listRuns: vi.fn(() => []),
    manageRun: vi.fn(() => ({ ok: false, error: { code: "INVALID_STATE" as const, message: "already complete" } })),
  } as unknown as MissionService;
}

describe("mission tools", () => {
  it("exposes strict schemas and bounded compiler/plan results", async () => {
    const api = service();
    const validate = await createValidateMissionTool(api, actorProvider).handler({ definition });
    const preview = await createPreviewMissionTool(api, actorProvider).handler({ definition });
    const saved = await createSaveMissionTool(api, actorProvider).handler({ definition });
    const listed = await createListMissionsTool(api).handler({});
    const run = await createRunMissionTool(api, actorProvider).handler({ definition });

    expect(validate).toMatchObject({ ok: true, details: { logicalStepCount: 1 } });
    expect(preview).toMatchObject({ ok: true, details: { expandedStepCount: 1 } });
    expect(saved).toMatchObject({ ok: true, details: { id: 1, name: "tool-test" } });
    expect(listed.summary).toContain('"totalCount":1');
    expect(run).toMatchObject({ ok: true, details: { taskPlanId: 5, constructionJobIds: [] } });
    expect(api.run).toHaveBeenCalledWith(expect.objectContaining({ actor }));
  });

  it("uses viewer read policies and operator-only persistence/control policies", async () => {
    const api = service();
    const viewer = { username: "Viewer", role: "viewer" as const, source: "minecraft-chat" as const };
    const validate = authorizeTool(createValidateMissionTool(api, actorProvider), viewer);
    const save = authorizeTool(createSaveMissionTool(api, actorProvider), viewer);
    const manage = authorizeTool(createManageMissionRunTool(api, actorProvider), viewer);
    const getRun = createGetMissionRunTool(api);

    expect(await validate.handler({ definition })).toMatchObject({ ok: true });
    expect(await save.handler({ definition })).toMatchObject({ ok: false, code: "PERMISSION_DENIED" });
    expect(await manage.handler({ runId: 1, action: "pause" })).toMatchObject({ ok: false, code: "PERMISSION_DENIED" });
    expect(getRun.policy).toMatchObject({ minimumRole: "viewer", effect: "read" });
  });

  it("maps service errors without exposing unbounded source or step params", async () => {
    const api = service();
    (api.manageRun as ReturnType<typeof vi.fn>).mockReturnValue({
      ok: false,
      error: {
        code: "PERMISSION_DENIED",
        message: "owner access required",
        compileErrors: Array.from({ length: 32 }, (_, index) => ({ stepId: `s${index}`, code: "ROLE_DENIED", message: "denied" })),
      },
    });
    const result = await createManageMissionRunTool(api, actorProvider).handler({ runId: 1, action: "resume" });
    expect(result).toMatchObject({ ok: false, code: "PERMISSION_DENIED" });
    expect((result.details?.errors as unknown[]).length).toBeLessThanOrEqual(16);
  });
});
