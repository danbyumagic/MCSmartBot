import type { Bot } from "mineflayer";
import type { Logger } from "../util/logger.js";
import type { Reflex } from "./types.js";
import type { ReflexRegistry } from "./registry.js";
import type { SkillRunner } from "../skills/runner.js";
import type { Bus } from "../bus/index.js";

export interface PreemptControllerDeps {
  bot: Bot;
  log: Logger;
  registry: ReflexRegistry;
  runner: SkillRunner;
  bus: Bus;
  /** Set of reflex names that emit a reflexAlert when fired. Default: all of them. */
  alertingReflexes?: Set<string>;
  /** ms cooldown between firings (default 200). Prevents 20Hz refire on physicsTick. */
  cooldownMs?: number;
  /** ms hard cap for a single reflex.run() (default 10_000) per spec §5.3 rule 3. */
  timeoutMs?: number;
}

export interface PreemptController {
  /** Call from a physicsTick subscription. Cheap. */
  tick(): void;
  /** True while a reflex is currently mid-run. */
  isFiring(): boolean;
  /** Abort the currently-running reflex, if any. */
  cancel(): void;
}

export function createPreemptController(deps: PreemptControllerDeps): PreemptController {
  const { bot, log, registry, runner, bus } = deps;
  const alerting = deps.alertingReflexes ?? new Set(registry.all().map((r) => r.name));
  const cooldownMs = deps.cooldownMs ?? 200;
  const timeoutMs = deps.timeoutMs ?? 10_000;

  let firing = false;
  let lastFire = 0;
  let activeController: AbortController | null = null;

  async function fire(reflex: Reflex): Promise<void> {
    firing = true;
    try {
      const wasActive = runner.activeName();
      const shouldRestart = runner.shouldRestartActive?.() ?? true;
      if (wasActive) {
        log.info({ reflex: reflex.name, skill: wasActive }, "reflex preempting active skill");
        runner.cancel();
      }
      const controller = new AbortController();
      activeController = controller;
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      try {
        await reflex.run(bot, controller.signal);
      } finally {
        clearTimeout(timer);
        if (activeController === controller) activeController = null;
      }
      if (alerting.has(reflex.name)) {
        bus.emit("agent.trigger", { kind: "reflexAlert", summary: `${reflex.name} fired` });
      }
      if (wasActive && shouldRestart) {
        log.info({ reflex: reflex.name, skill: wasActive }, "reflex done; restarting skill");
        runner.restart();
      }
    } catch (err) {
      log.error({ err, reflex: reflex.name }, "reflex threw");
    } finally {
      firing = false;
      lastFire = Date.now();
    }
  }

  function tick(): void {
    if (firing) return;
    if (Date.now() - lastFire < cooldownMs) return;
    const reflex = registry.findFiring(bot);
    if (!reflex) return;
    void fire(reflex);
  }

  return {
    tick,
    isFiring: () => firing,
    cancel: () => activeController?.abort(),
  };
}
