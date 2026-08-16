import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

interface UpstreamReuseEntry {
  name?: unknown;
  repository?: unknown;
  commit?: unknown;
  license?: unknown;
  licenseFile?: unknown;
  sourcePaths?: unknown;
  adaptedPaths?: unknown;
  notes?: unknown;
}

interface UpstreamReuseManifest {
  approvedReuse?: unknown;
  referenceOnly?: unknown;
}

const root = process.cwd();
const manifestPath = join(root, "docs", "upstream-reuse.json");

function readManifest(): UpstreamReuseManifest {
  return JSON.parse(readFileSync(manifestPath, "utf8")) as UpstreamReuseManifest;
}

describe("upstream reuse provenance", () => {
  it("pins every approved source to a locally licensed, reviewable snapshot", () => {
    const manifest = readManifest();
    expect(Array.isArray(manifest.approvedReuse)).toBe(true);
    expect(Array.isArray(manifest.referenceOnly)).toBe(true);

    const approved = manifest.approvedReuse as UpstreamReuseEntry[];
    expect(approved).toHaveLength(7);
    expect(new Set(approved.map((entry) => entry.name)).size).toBe(approved.length);

    for (const entry of approved) {
      expect(typeof entry.name).toBe("string");
      expect(typeof entry.repository).toBe("string");
      expect(entry.repository).toMatch(/^https:\/\/github\.com\/[\w.-]+\/[\w.-]+$/);
      expect(entry.commit).toMatch(/^[0-9a-f]{40}$/);
      expect(["MIT", "Apache-2.0"]).toContain(entry.license);
      expect(String(entry.license)).not.toMatch(/agpl|gpl|unknown/i);
      expect(typeof entry.licenseFile).toBe("string");
      expect(existsSync(join(root, String(entry.licenseFile)))).toBe(true);
      expect(Array.isArray(entry.sourcePaths)).toBe(true);
      expect((entry.sourcePaths as unknown[]).length).toBeGreaterThan(0);
      expect((entry.sourcePaths as unknown[]).every((path) => typeof path === "string" && path)).toBe(true);
      expect(Array.isArray(entry.adaptedPaths)).toBe(true);
      expect((entry.adaptedPaths as unknown[]).every((path) => typeof path === "string" && path)).toBe(true);
      expect(new Set(entry.adaptedPaths as string[]).size).toBe((entry.adaptedPaths as string[]).length);
      for (const adaptedPath of entry.adaptedPaths as string[]) {
        const fullPath = join(root, adaptedPath);
        expect(existsSync(fullPath)).toBe(true);
        const contents = readFileSync(fullPath, "utf8");
        expect(contents).toContain(String(entry.commit));
        expect(contents).toContain(String(entry.license));
      }
      expect(typeof entry.notes).toBe("string");
      expect(String(entry.notes).trim()).not.toBe("");
    }
  });
});
