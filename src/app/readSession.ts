import Database from "better-sqlite3";
import { existsSync } from "node:fs";
import { join } from "node:path";
import type {
  MissionRunSummaryDTO,
  MissionSummaryDTO,
  TransactionListInput,
  WorldTransactionSummaryDTO,
  RuntimeReadSession,
} from "./contracts.js";
import type { RuntimeProfile } from "./profile.js";
import {
  missionDetail,
  missionRunDetail,
  missionRunSummary,
  missionSummary,
  transactionDetail,
  transactionSummary,
} from "./data.js";
import {
  getMissionDefinition,
  getMissionRun,
  listMissionDefinitions,
  listMissionRuns,
} from "../missions/store.js";
import type { MissionRunStatus } from "../missions/types.js";
import {
  getTransaction,
  listTransactions,
} from "../world/transactions/store.js";
import { makeServerKey } from "../exploration/mapStore.js";

/**
 * Read-only profile access used by the desktop while the bot is stopped.
 * It opens no writable connection and never runs migrations or schema writes.
 */
export function openProfileReadOnlySession(profile: RuntimeProfile): RuntimeReadSession {
  const databasePath = join(profile.config.dataDir, "memory.sqlite");
  const serverKey = makeServerKey(profile.config.serverHost, profile.config.serverPort);
  const db = existsSync(databasePath)
    ? new Database(databasePath, { readonly: true, fileMustExist: true })
    : null;

  const empty = <T,>(): T[] => [];
  const session: RuntimeReadSession = {
    listMissions: (input) => db
      ? listMissionDefinitions(db, input).map(missionSummary)
      : empty<MissionSummaryDTO>(),
    getMission: (id) => {
      const row = db ? getMissionDefinition(db, id) : undefined;
      return row ? missionDetail(row) : undefined;
    },
    listMissionRuns: (input) => db
      ? listMissionRuns(db, input === undefined ? undefined : {
        ...(input.definitionId === undefined ? {} : { definitionId: input.definitionId }),
        ...(input.taskPlanId === undefined ? {} : { taskPlanId: input.taskPlanId }),
        ...(input.status === undefined ? {} : { status: input.status as MissionRunStatus }),
        ...(input.limit === undefined ? {} : { limit: input.limit }),
      }).map(missionRunSummary)
      : empty<MissionRunSummaryDTO>(),
    getMissionRun: (id) => {
      const row = db ? getMissionRun(db, id) : undefined;
      return row ? missionRunDetail(row) : undefined;
    },
    listWorldTransactions: (input?: TransactionListInput) => db
      ? listTransactions(db, {
        serverKey,
        ...(input?.dimension === undefined ? {} : { dimension: input.dimension }),
        ...(input?.status === undefined ? {} : { status: input.status as never }),
        ...(input?.limit === undefined ? {} : { limit: input.limit }),
      }).map(transactionSummary)
      : empty<WorldTransactionSummaryDTO>(),
    getWorldTransaction: (id) => {
      const row = db ? getTransaction(db, id) : undefined;
      return row ? transactionDetail(row) : undefined;
    },
    close: () => { db?.close(); },
  };
  return session;
}
