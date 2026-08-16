import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { assertCurrentConstructionSourceAccess } from "../../src/construction/sourceAccess.js";
import {
  getBlueprintByName,
  registerCompiledBlueprint,
  upsertBlueprint,
} from "../../src/construction/store.js";
import { openDatabase, type DB } from "../../src/memory/db.js";
import { setPlayerRole } from "../../src/permissions/roles.js";

let tempDirectory: string;
let db: DB;

beforeEach(() => {
  tempDirectory = mkdtempSync(join(tmpdir(), "smbmc-source-access-"));
  db = openDatabase(join(tempDirectory, "memory.sqlite"));
});

afterEach(() => {
  db.close();
  rmSync(tempDirectory, { recursive: true, force: true });
});

function registerSourceBlueprint(input: {
  readonly name: string;
  readonly targetVersion?: string;
  readonly report?: string;
}) {
  return registerCompiledBlueprint(db, {
    name: input.name,
    blocks: [{ x: 0, y: 0, z: 0, block: "stone" }],
    sourceSchema: "smartbot.build/v1",
    targetVersion: input.targetVersion ?? "1.21.11",
    sourceJson: '{"schema":"smartbot.build/v1"}',
    sourceHash: "a".repeat(64),
    compileReportJson: input.report ?? '{"requiredAccess":"operator"}',
    creator: { username: "Owner", role: "owner", source: "desktop" },
  });
}

function authorize(
  blueprintName: string,
  actor = { username: "Builder", role: "operator", source: "minecraft-chat" } as const,
  versions: { configuredVersion?: string; liveVersion?: string } = {},
) {
  const blueprint = getBlueprintByName(db, blueprintName);
  if (!blueprint) throw new Error(`missing test blueprint '${blueprintName}'`);
  return assertCurrentConstructionSourceAccess({
    db,
    ownerUsername: "Owner",
    blueprint,
    actor,
    ...versions,
  });
}

describe("construction source access", () => {
  it("returns no source grant for legacy raw blueprints", () => {
    upsertBlueprint(db, {
      name: "raw",
      blocks: [{ x: 0, y: 0, z: 0, block: "stone" }],
    });

    expect(authorize("raw", { username: "Viewer", role: "viewer", source: "minecraft-chat" })).toBeUndefined();
  });

  it("resolves the actor's current role instead of trusting its durable snapshot", () => {
    registerSourceBlueprint({ name: "owner-build", report: '{"requiredAccess":"owner"}' });
    setPlayerRole(db, { username: "Builder", role: "operator", grantedBy: "Owner" });

    expect(() => authorize("owner-build", {
      username: "Builder",
      // This stale audit snapshot must not grant the source access.
      role: "owner",
      source: "minecraft-chat",
    })).toThrow(/requires owner access; actor 'Builder' currently has operator/);

    const grant = authorize("owner-build", { username: "Owner", role: "viewer", source: "desktop" });
    expect(grant).toMatchObject({
      requiredAccess: "owner",
      targetVersion: "1.21.11",
      sourceHash: "a".repeat(64),
      creator: { username: "Owner", source: "desktop" },
    });
  });

  it("fails closed when a source report is malformed or lacks an access requirement", () => {
    registerSourceBlueprint({ name: "corrupt-report", report: '{"placementCount":1}' });

    expect(() => authorize("corrupt-report")).toThrow(/invalid source access report/);
  });

  it("requires an exact configured and live Minecraft version when either is supplied", () => {
    registerSourceBlueprint({ name: "versioned" });
    setPlayerRole(db, { username: "Builder", role: "operator", grantedBy: "Owner" });

    expect(authorize("versioned", undefined, {
      configuredVersion: "1.21.11",
      liveVersion: "1.21.11",
    })).toMatchObject({ targetVersion: "1.21.11" });
    expect(() => authorize("versioned", undefined, { configuredVersion: "1.21.10" }))
      .toThrow(/targets Minecraft 1\.21\.11, but configured runtime is 1\.21\.10/);
    expect(() => authorize("versioned", undefined, { liveVersion: "1.21.10" }))
      .toThrow(/targets Minecraft 1\.21\.11, but live bot is 1\.21\.10/);
  });
});
