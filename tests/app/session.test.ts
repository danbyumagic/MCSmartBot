import { describe, expect, it, vi } from "vitest";
import { createLogger } from "../../src/util/logger.js";
import {
  openRuntimeSession,
  type RuntimeSessionDependencies,
} from "../../src/app/session.js";
import type { RuntimeProfile } from "../../src/app/profile.js";
import type { DB } from "../../src/memory/db.js";
import type { InstanceLock } from "../../src/runtime/instanceLock.js";
import type { ReconnectSupervisor } from "../../src/runtime/reconnect.js";
import type { DashboardServer } from "../../src/dashboard/server.js";
import type { ConnectionRuntime } from "../../src/runtime/connection.js";

function profile(): RuntimeProfile {
  return {
    envPath: "/tmp/smartbot-profile/.env",
    rootDir: "/tmp/smartbot-profile",
    config: {
      serverHost: "localhost",
      serverPort: 25565,
      serverVersion: "1.21.11",
      botUsername: "SmartBot",
      botAuth: "offline",
      ownerUsername: "alice",
      agentProvider: "codex",
      dataDir: "/tmp/smartbot-profile/data",
      logLevel: "error",
      chatMirrorEnabled: true,
      hpFleeThreshold: 6,
      foodEatThreshold: 14,
      agentIdleTickMinutes: 5,
      reconnectBaseDelayMs: 1000,
      reconnectMaxDelayMs: 60000,
      reconnectJitterRatio: 0.2,
      dashboardEnabled: true,
      dashboardHost: "127.0.0.1",
      dashboardPort: 8787,
    },
    serverConfig: { commands: [], notes: [], name: "Test server" },
    serverConfigPath: "/tmp/smartbot-profile/server.json",
  };
}

function logger(): Parameters<RuntimeSessionDependencies["createLogger"]>[0] extends never
  ? never
  : ReturnType<RuntimeSessionDependencies["createLogger"]> {
  const value = {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    child: vi.fn(),
  } as unknown as ReturnType<RuntimeSessionDependencies["createLogger"]>;
  value.child = vi.fn(() => value) as typeof value.child;
  return value;
}

function runtime(): ConnectionRuntime {
  return {
    sendPublicChat: vi.fn(),
    requestAgent: vi.fn(),
    runCommand: vi.fn(),
    getStatus: () => "connected",
    getLiveState: () => ({
      connection: "connected",
      activeSkill: null,
      health: 20,
      food: 20,
      dimension: "overworld",
      position: { x: 1, y: 2, z: 3 },
      inventory: null,
    }),
    emergencyStop: vi.fn(() => ({
      activeSkill: null,
      discardedTriggers: 0,
      agentCancelled: true,
      pausedPlanId: null,
    })),
    stop: vi.fn(),
  };
}

function dependencies(options: {
  order: string[];
  runtime?: ConnectionRuntime;
  dashboardStart?: () => Promise<void>;
  dashboardStop?: () => Promise<void>;
}): Partial<RuntimeSessionDependencies> {
  const db = {
    close: vi.fn(() => options.order.push("db-close")),
  } as unknown as DB;
  const lock = {
    release: vi.fn(() => options.order.push("lock-release")),
  } as unknown as InstanceLock;
  const activeRuntime = options.runtime ?? runtime();
  let current: ConnectionRuntime | null = null;
  const supervisor = {
    start: vi.fn(() => {
      options.order.push("supervisor-start");
      current = activeRuntime;
    }),
    stop: vi.fn(() => {
      options.order.push("supervisor-stop");
      current = null;
    }),
    current: () => current,
    attempts: () => 0,
  } as unknown as ReconnectSupervisor;
  const dashboard = {
    start: options.dashboardStart ?? (async () => { options.order.push("dashboard-start"); }),
    stop: options.dashboardStop ?? (async () => { options.order.push("dashboard-stop"); }),
    url: () => "http://127.0.0.1:8787",
  } as unknown as DashboardServer;
  const log = logger();
  return {
    acquireInstanceLock: vi.fn(() => {
      options.order.push("lock");
      return lock;
    }),
    createLogger: vi.fn(() => {
      options.order.push("logger");
      return log;
    }),
    verifyAgentSubscriptionAuth: vi.fn(async () => {
      options.order.push("auth");
      return { provider: "codex" as const, executable: "/usr/local/bin/codex" };
    }),
    openDatabase: vi.fn(() => {
      options.order.push("db");
      return db;
    }),
    reconcileInterruptedSkillRuns: vi.fn(() => {
      options.order.push("reconcile");
      return 0;
    }),
    reconcileOpenTransactions: vi.fn(() => {
      options.order.push("transactions");
      return 0;
    }),
    adoptLegacyWorldMap: vi.fn(() => {
      options.order.push("map");
      return 0;
    }),
    removePlayerRole: vi.fn(() => {
      options.order.push("role");
      return false;
    }),
    pruneOldRecords: vi.fn(() => options.order.push("retention")),
    makeServerKey: vi.fn(() => "localhost:25565"),
    createReconnectSupervisor: vi.fn(() => {
      options.order.push("supervisor");
      return supervisor;
    }),
    createConnectionRuntime: vi.fn(() => activeRuntime),
    createDashboardServer: vi.fn(() => {
      options.order.push("dashboard");
      return dashboard;
    }),
    now: vi.fn(() => 100),
  };
}

describe("openRuntimeSession", () => {
  it("preserves startup order, forwards profile assets, and starts once", async () => {
    const order: string[] = [];
    const deps = dependencies({ order });
    const session = await openRuntimeSession({
      profile: profile(),
      prettyLogs: false,
      assets: {
        schemaPath: "/resources/schema.sql",
        dashboardHtmlPath: "/resources/index.html",
      },
      dependencies: deps,
    });

    expect(order).toEqual([
      "lock", "logger", "auth", "db", "reconcile", "transactions", "map", "role", "retention",
      "supervisor", "dashboard", "dashboard-start",
    ]);
    expect(deps.openDatabase).toHaveBeenCalledWith(
      "/tmp/smartbot-profile/data/memory.sqlite",
      { schemaPath: "/resources/schema.sql" },
    );
    expect(deps.createDashboardServer).toHaveBeenCalledWith(expect.objectContaining({
      htmlPath: "/resources/index.html",
    }));
    expect(deps.verifyAgentSubscriptionAuth).toHaveBeenCalledWith({
      provider: "codex",
      claude: { configuredPath: undefined },
      codex: { configuredPath: undefined },
    });
    session.start();
    session.start();
    expect(order).toContain("supervisor-start");
    expect((deps.createReconnectSupervisor as ReturnType<typeof vi.fn>)).toHaveBeenCalledWith(
      expect.objectContaining({ connect: expect.any(Function) }),
    );
    expect(session.snapshot()).toMatchObject({
      connectionStatus: "connected",
      dashboardUrl: "http://127.0.0.1:8787",
    });
  });

  it("stops resources once in cleanup order and emergency-stops the current runtime", async () => {
    const order: string[] = [];
    const active = runtime();
    const deps = dependencies({ order, runtime: active });
    const session = await openRuntimeSession({ profile: profile(), dependencies: deps });
    session.start();
    const emergency = session.emergencyStop("desktop");
    expect(emergency).toMatchObject({ agentCancelled: true });
    expect(active.emergencyStop).toHaveBeenCalledWith("desktop");

    const first = session.stop("test");
    const second = session.stop("duplicate");
    expect(first).toBe(second);
    await Promise.all([first, second]);
    expect(order.slice(-4)).toEqual([
      "supervisor-stop", "dashboard-stop", "db-close", "lock-release",
    ]);
    expect(active.emergencyStop).toHaveBeenCalledOnce();
  });

  it("rolls back acquired resources when dashboard startup fails", async () => {
    const order: string[] = [];
    const deps = dependencies({
      order,
      dashboardStart: async () => {
        order.push("dashboard-start");
        throw new Error("port already in use");
      },
    });
    await expect(openRuntimeSession({ profile: profile(), dependencies: deps }))
      .rejects.toThrow("port already in use");
    expect(order).toContain("dashboard-start");
    expect(order.slice(-4)).toEqual([
      "supervisor-stop", "dashboard-stop", "db-close", "lock-release",
    ]);
  });
});
