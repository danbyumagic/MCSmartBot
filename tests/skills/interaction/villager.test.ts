import { beforeEach, describe, expect, it, vi } from "vitest";
import { Vec3 } from "vec3";
import type { SkillContext } from "../../../src/skills/types.js";

const { pathfindTo } = vi.hoisted(() => ({ pathfindTo: vi.fn() }));

vi.mock("../../../src/skills/pathfinder.js", () => ({
  goals: {
    GoalNear: class GoalNear {
      constructor(
        public readonly x: number,
        public readonly y: number,
        public readonly z: number,
        public readonly range: number,
      ) {}
    },
  },
  pathfindTo,
}));

import { openVillager } from "../../../src/skills/interaction/openVillager.js";
import { tradeVillager } from "../../../src/skills/interaction/tradeVillager.js";

function entity(id: number, name: string, type: string, x: number) {
  return { id, name, type, position: new Vec3(x, 64, 0), isValid: true };
}

function offer(overrides: Record<string, unknown> = {}) {
  return {
    inputItem1: { name: "emerald", count: 5, type: 388, metadata: 0 },
    inputItem2: null,
    hasItem2: false,
    outputItem: { name: "bread", count: 3, type: 297, metadata: 0 },
    nbTradeUses: 0,
    maximumNbTradeUses: 12,
    tradeDisabled: false,
    ...overrides,
  };
}

function villagerWindow(trades: unknown[] = [offer()]) {
  return {
    type: "minecraft:villager",
    title: "Villager",
    slots: [null],
    selectedItem: null,
    trades,
  };
}

function botWith(targets: Record<number, object>, currentWindow: any = null) {
  const self = entity(0, "player", "player", 0);
  let inventory = [
    { name: "emerald", count: 10, type: 388 },
    { name: "bread", count: 0, type: 297 },
  ];
  return {
    entity: self,
    entities: { 0: self, ...targets } as Record<number, any>,
    players: {},
    currentWindow,
    inventory: { items: () => inventory },
    openVillager: vi.fn(async () => currentWindow),
    trade: vi.fn(async (window: any, index: number, times: number) => {
      const live = window.trades[index];
      inventory = [
        { name: "emerald", count: 10 - live.inputItem1.count * times, type: 388 },
        { name: "bread", count: live.outputItem.count * times, type: 297 },
      ];
      live.nbTradeUses += times;
    }),
  };
}

function context(bot: unknown, controller = new AbortController()): SkillContext {
  const log = {
    debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn(), trace: vi.fn(), fatal: vi.fn(),
    child: () => log, level: "error", bindings: () => ({}),
  } as unknown as SkillContext["log"];
  return { bot: bot as SkillContext["bot"], signal: controller.signal, log, reportProgress: vi.fn() };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((resolvePromise) => { resolve = resolvePromise; });
  return { promise, resolve };
}

beforeEach(() => pathfindTo.mockReset().mockResolvedValue(undefined));

describe("villager interactions", () => {
  it("opens a freshly resolved villager and returns bounded sanitized offer DTOs", async () => {
    const villager = entity(9, "villager", "mob", 2);
    const window = villagerWindow(Array.from({ length: 130 }, () => offer()));
    const bot = botWith({ 9: villager }, window);

    const result = await openVillager.run({ selector: { entityId: 9 } }, context(bot));

    expect(bot.openVillager).toHaveBeenCalledWith(villager);
    expect(result).toMatchObject({ ok: true, data: { target: { id: 9, name: "villager" } } });
    expect(result.data?.trades[0]).toMatchObject({
      index: 0,
      inputs: [{ name: "emerald", count: 5 }],
      output: { name: "bread", count: 3 },
      remainingUses: 12,
      disabled: false,
    });
    expect((result.data?.trades as unknown[])).toHaveLength(128);
  });

  it("rejects a non-villager and a villager that despawns after bounded routing", async () => {
    const cow = entity(7, "cow", "mob", 2);
    const first = botWith({ 7: cow }, villagerWindow());
    const nonVillager = await openVillager.run({ selector: { entityId: 7 } }, context(first));
    expect(nonVillager).toMatchObject({ ok: false, code: "TARGET_UNAVAILABLE" });
    expect(first.openVillager).not.toHaveBeenCalled();

    const villager = entity(9, "villager", "mob", 8);
    const second = botWith({ 9: villager }, villagerWindow());
    pathfindTo.mockImplementation(async () => { delete second.entities[9]; });
    const stale = await openVillager.run({ selector: { entityId: 9 } }, context(second));
    expect(stale).toMatchObject({ ok: false, code: "TARGET_UNAVAILABLE" });
    expect(second.openVillager).not.toHaveBeenCalled();
  });

  it("validates an enabled live offer and verifies inventory and use deltas", async () => {
    const window = villagerWindow();
    const bot = botWith({}, window);

    const result = await tradeVillager.run({ index: 0, times: 1 }, context(bot));

    expect(bot.trade).toHaveBeenCalledWith(window, 0, 1);
    expect(result).toMatchObject({
      ok: true,
      data: { index: 0, times: 1, outputDelta: 3, inputDeltas: { emerald: -5 }, usesBefore: 0, usesAfter: 1 },
    });
  });

  it("fails closed for no window, invalid/disabled offers, and missing materials", async () => {
    const none = botWith({}, null);
    await expect(tradeVillager.run({ index: 0, times: 1 }, context(none))).resolves.toMatchObject({
      ok: false, code: "TARGET_UNAVAILABLE",
    });

    const disabledWindow = villagerWindow([offer({ tradeDisabled: true })]);
    const disabled = botWith({}, disabledWindow);
    await expect(tradeVillager.run({ index: 0, times: 1 }, context(disabled))).resolves.toMatchObject({
      ok: false, code: "TARGET_UNAVAILABLE",
    });
    await expect(tradeVillager.run({ index: 1, times: 1 }, context(disabled))).resolves.toMatchObject({
      ok: false, code: "INVALID_PARAMS",
    });

    const missingWindow = villagerWindow();
    const missing = botWith({}, missingWindow);
    missing.inventory.items = () => [];
    const result = await tradeVillager.run({ index: 0, times: 1 }, context(missing));
    expect(result).toMatchObject({ ok: false, code: "NO_MATERIAL" });
    expect(missing.trade).not.toHaveBeenCalled();
  });

  it("does not claim a verified trade if the window closes during Mineflayer's request", async () => {
    const window = villagerWindow();
    const bot = botWith({}, window);
    bot.trade.mockImplementation(async () => { bot.currentWindow = null; });

    const result = await tradeVillager.run({ index: 0, times: 1 }, context(bot));

    expect(result).toMatchObject({ ok: false, code: "STALE_STATE", details: { actionMayHaveCompleted: true } });
  });

  it("reports interruption truthfully when opening or trading is cancelled in flight", async () => {
    const villager = entity(9, "villager", "mob", 2);
    const window = villagerWindow();
    const openingBot = botWith({ 9: villager }, window);
    const opening = deferred<typeof window>();
    openingBot.openVillager.mockImplementation(() => opening.promise);
    const openingController = new AbortController();
    const pendingOpen = openVillager.run({ selector: { entityId: 9 } }, context(openingBot, openingController));
    await flushMicrotasks();
    expect(openingBot.openVillager).toHaveBeenCalledWith(villager);
    openingController.abort();
    opening.resolve(window);
    await expect(pendingOpen).resolves.toMatchObject({
      ok: false, code: "INTERRUPTED", details: { actionMayHaveCompleted: true },
    });

    const tradingBot = botWith({}, window);
    const trading = deferred<void>();
    tradingBot.trade.mockImplementation(() => trading.promise);
    const tradingController = new AbortController();
    const pendingTrade = tradeVillager.run({ index: 0, times: 1 }, context(tradingBot, tradingController));
    await flushMicrotasks();
    expect(tradingBot.trade).toHaveBeenCalledWith(window, 0, 1);
    tradingController.abort();
    trading.resolve();
    await expect(pendingTrade).resolves.toMatchObject({
      ok: false, code: "INTERRUPTED", details: { actionMayHaveCompleted: true },
    });
  });

  it("has deliberate operator inventory policies and bounded parameters", () => {
    expect(openVillager.policy).toEqual({
      minimumRole: "operator", effect: "world-change", reversible: false, mission: "public",
    });
    expect(tradeVillager.policy).toEqual({
      minimumRole: "operator", effect: "inventory", reversible: false, mission: "public",
    });
    expect(tradeVillager.params.parse({ index: 3 })).toEqual({ index: 3, times: 1 });
    expect(() => tradeVillager.params.parse({ index: 0, times: 65 })).toThrow();
  });
});

async function flushMicrotasks(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
}
