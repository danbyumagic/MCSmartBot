import {
  createServer,
  type RequestListener,
  type Server,
} from "node:http";
import { readFileSync } from "node:fs";
import type { AddressInfo } from "node:net";
import type { DB } from "../memory/db.js";
import type { Logger } from "../util/logger.js";
import { getDashboardSnapshot } from "./data.js";
import type { BotRuntimeState } from "../runtime/state.js";
import { getDashboardMap } from "../exploration/mapStore.js";

export interface DashboardServer {
  start(): Promise<void>;
  stop(): Promise<void>;
  url(): string | undefined;
}

export function createDashboardRequestHandler(deps: {
  db: DB;
  log: Logger;
  getConnectionStatus: () => string;
  getRuntimeState?: () => BotRuntimeState;
  ownerUsername?: string;
  currentServerKey?: string;
  currentServerLabel?: string;
  html?: string;
  htmlPath?: string;
}): RequestListener {
  const html = deps.html ?? readFileSync(
    deps.htmlPath ?? new URL("./index.html", import.meta.url),
    "utf8",
  );
  return (req, res) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("Referrer-Policy", "no-referrer");
    res.setHeader(
      "Content-Security-Policy",
      "default-src 'self'; style-src 'self' 'unsafe-inline'; " +
      "script-src 'self' 'unsafe-inline'; connect-src 'self'; img-src 'self' data:",
    );
    if (req.method !== "GET") {
      res.writeHead(405, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "method not allowed" }));
      return;
    }
    if (url.pathname === "/api/status") {
      try {
        const snapshot = getDashboardSnapshot(
          deps.db,
          deps.getRuntimeState?.() ?? deps.getConnectionStatus(),
          Date.now(),
          deps.ownerUsername,
          deps.currentServerKey,
          deps.currentServerLabel,
        );
        res.writeHead(200, {
          "Content-Type": "application/json; charset=utf-8",
          "Cache-Control": "no-store",
        });
        res.end(JSON.stringify(snapshot));
      } catch (err) {
        deps.log.error({ err }, "dashboard snapshot failed");
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "dashboard snapshot unavailable" }));
      }
      return;
    }
    if (url.pathname === "/api/map") {
      try {
        const serverKey = (url.searchParams.get("server") ?? deps.currentServerKey ?? "legacy").trim();
        const dimension = url.searchParams.get("dimension")?.trim() || undefined;
        if (!serverKey || serverKey.length > 255 || (dimension?.length ?? 0) > 64) {
          res.writeHead(400, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: "invalid map selection" }));
          return;
        }
        const map = getDashboardMap(deps.db, serverKey, dimension);
        res.writeHead(200, {
          "Content-Type": "application/json; charset=utf-8",
          "Cache-Control": "no-store",
        });
        res.end(JSON.stringify(map));
      } catch (err) {
        deps.log.error({ err }, "dashboard map failed");
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "dashboard map unavailable" }));
      }
      return;
    }
    if (url.pathname === "/" || url.pathname === "/index.html") {
      res.writeHead(200, {
        "Content-Type": "text/html; charset=utf-8",
        "Cache-Control": "no-store",
      });
      res.end(html);
      return;
    }
    res.writeHead(404, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "not found" }));
  };
}

export function createDashboardServer(deps: {
  db: DB;
  log: Logger;
  host: string;
  port: number;
  enabled: boolean;
  getConnectionStatus: () => string;
  getRuntimeState?: () => BotRuntimeState;
  ownerUsername?: string;
  currentServerKey?: string;
  currentServerLabel?: string;
  htmlPath?: string;
}): DashboardServer {
  let server: Server | null = null;
  let dashboardUrl: string | undefined;
  const resolvedHtml = deps.enabled
    ? readFileSync(deps.htmlPath ?? new URL("./index.html", import.meta.url), "utf8")
    : "";

  function start(): Promise<void> {
    if (!deps.enabled || server) return Promise.resolve();
    server = createServer(createDashboardRequestHandler({
      db: deps.db,
      log: deps.log,
      getConnectionStatus: deps.getConnectionStatus,
      getRuntimeState: deps.getRuntimeState,
      ownerUsername: deps.ownerUsername,
      currentServerKey: deps.currentServerKey,
      currentServerLabel: deps.currentServerLabel,
      html: resolvedHtml,
      htmlPath: deps.htmlPath,
    }));
    return new Promise((resolve, reject) => {
      server!.once("error", reject);
      server!.listen(deps.port, deps.host, () => {
        server!.off("error", reject);
        const address = server!.address() as AddressInfo;
        const displayHost = deps.host.includes(":") ? `[${deps.host}]` : deps.host;
        dashboardUrl = `http://${displayHost}:${address.port}`;
        deps.log.info({ url: dashboardUrl }, "operations dashboard ready");
        resolve();
      });
    });
  }

  function stop(): Promise<void> {
    if (!server) return Promise.resolve();
    const closing = server;
    server = null;
    dashboardUrl = undefined;
    return new Promise((resolve) => closing.close(() => resolve()));
  }

  return { start, stop, url: () => dashboardUrl };
}
