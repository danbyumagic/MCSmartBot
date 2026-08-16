import { join } from "node:path";
import { existsSync } from "node:fs";
import {
  createSmartBotApp,
  SmartBotControlError,
} from "./app/controller.js";
import { createAppLogBuffer } from "./app/logBuffer.js";
import { loadRuntimeProfile } from "./app/profile.js";
import { openRuntimeSession } from "./app/session.js";
import { openProfileReadOnlySession } from "./app/readSession.js";
import { startCli } from "./cli/index.js";
import type { SmartBotAppSnapshot } from "./app/contracts.js";

async function main(): Promise<void> {
  const configuredPath = process.env.SMARTBOT_PROFILE_PATH?.trim()
    || process.env.SMARTBOT_ENV_PATH?.trim();
  const envPath = configuredPath
    || [join(process.cwd(), "smartbot.json"), join(process.cwd(), ".env")]
      .find((candidate) => existsSync(candidate))
    || join(process.cwd(), "smartbot.json");
  const profile = loadRuntimeProfile({ envPath });
  const logBuffer = createAppLogBuffer();
  const app = createSmartBotApp({
    logBuffer,
    openReadOnlySession: async () => openProfileReadOnlySession(profile),
    openSession: () => openRuntimeSession({
      profile,
      prettyLogs: true,
      onLog: (entry) => logBuffer.append(entry),
    }),
  });

  await app.start();

  let acceptingInput = true;
  let cliHandle: { stop(): void } | null = null;
  let shutdownPromise: Promise<void> | null = null;

  const shutdown = (reason: string): Promise<void> => {
    if (shutdownPromise) return shutdownPromise;
    acceptingInput = false;
    cliHandle?.stop();
    shutdownPromise = (async () => {
      try {
        const snapshot = await app.stop(reason);
        process.exitCode = snapshot.phase === "failed" ? 1 : 0;
      } catch (error) {
        process.exitCode = 1;
        console.error(formatStartupError(error));
      } finally {
        process.removeListener("SIGINT", onSigint);
        process.removeListener("SIGTERM", onSigterm);
      }
    })();
    return shutdownPromise;
  };
  const onSigint = (): void => { void shutdown("SIGINT"); };
  const onSigterm = (): void => { void shutdown("SIGTERM"); };

  const reportControlFailure = (verb: string, error: unknown): void => {
    if (error instanceof SmartBotControlError && error.code === "NOT_RUNNING") {
      console.warn(`cannot ${verb} while disconnected`);
      return;
    }
    console.warn(formatStartupError(error));
  };

  cliHandle = startCli({
    sendPublicChat: (text) => {
      if (!acceptingInput) return;
      try {
        app.sendPublicChat(text);
      } catch (error) {
        reportControlFailure("send chat", error);
      }
    },
    requestAgent: (text) => {
      if (!acceptingInput) return;
      try {
        app.requestAgent(text);
      } catch (error) {
        reportControlFailure("request agent", error);
      }
    },
    runCommand: (command) => {
      if (!acceptingInput) return;
      try {
        app.runCommand(command);
      } catch (error) {
        reportControlFailure("run command", error);
      }
    },
    getStatus: () => formatCliStatus(app.snapshot()),
    onQuit: () => { void shutdown("cli quit"); },
  });

  process.on("SIGINT", onSigint);
  process.on("SIGTERM", onSigterm);
}

void main().catch((error) => {
  process.exitCode = 1;
  console.error(formatStartupError(error));
});

export function formatCliStatus(snapshot: SmartBotAppSnapshot): string {
  const live = snapshot.runtime;
  if (live.connection !== "connected" || !live.position) {
    return snapshot.connectionStatus;
  }
  return (
    `hp=${live.health ?? 0} food=${live.food ?? 0} ` +
    `pos=${live.position.x.toFixed(1)},${live.position.y.toFixed(1)},${live.position.z.toFixed(1)}`
  );
}

function formatStartupError(error: unknown): string {
  if (error instanceof SmartBotControlError) return error.message;
  const message = error instanceof Error ? error.message : String(error ?? "");
  const normalized = message.toLowerCase();
  if (/runtime profile|profile file|profile.*missing/.test(normalized)) {
    return "Runtime profile is missing or unreadable.";
  }
  if (/invalid configuration/.test(normalized)) return "Runtime configuration is invalid.";
  if (/openrouter|api key|api-key/.test(normalized)) {
    return "OpenRouter API key is missing or invalid.";
  }
  if (/claude|not authenticated|sign in|authenticated/.test(normalized)) {
    return "Claude Code is unavailable or not authenticated.";
  }
  if (/another smartbot|already running|instance lock|smartbot\.lock/.test(normalized)) {
    return "Another SmartBot instance is already running.";
  }
  return "SmartBot could not start.";
}
