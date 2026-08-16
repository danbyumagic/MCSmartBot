import { readdirSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { dirname } from "node:path";
import { spawnSync } from "node:child_process";

const scriptDir = dirname(fileURLToPath(import.meta.url));
const root = resolve(scriptDir, "..");
const testsRoot = join(root, "tests");

const deferredPrefixes = [
  "tests/desktop/",
  "tests/dashboard/",
  "tests/skills/combat/",
];

const longRunningStressTests = new Map([
  ["tests/skills/construction/buildBlueprint.execution.test.ts", 60_000],
]);

function walk(dir) {
  const files = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const absolute = join(dir, entry.name);
    if (entry.isDirectory()) files.push(...walk(absolute));
    else files.push(absolute);
  }
  return files;
}

const files = walk(testsRoot)
  .map((absolute) => relative(root, absolute).replaceAll("\\", "/"))
  .filter((path) => path.endsWith(".test.ts"))
  .filter((path) => !deferredPrefixes.some((prefix) => path.startsWith(prefix)))
  .sort();

if (files.length === 0) {
  console.error("No headless release tests were discovered.");
  process.exit(1);
}

const vitest = process.platform === "win32"
  ? join(root, "node_modules", ".bin", "vitest.cmd")
  : join(root, "node_modules", ".bin", "vitest");

console.log(`Running ${files.length} headless release test files in isolation.`);
const failures = [];

for (let index = 0; index < files.length; index += 1) {
  const file = files[index];
  const args = [
    "run",
    file,
    "--config",
    "vitest.release.config.ts",
    "--reporter=dot",
  ];
  const stressTimeout = longRunningStressTests.get(file);
  if (stressTimeout !== undefined) {
    args.push("--testTimeout", String(stressTimeout));
  }

  const result = spawnSync(vitest, args, {
    cwd: root,
    encoding: "utf8",
    shell: false,
    maxBuffer: 16 * 1024 * 1024,
  });

  if (result.error) {
    const reason = `launch error: ${result.error.message}`;
    failures.push({ file, reason });
    console.error(`[FAIL ${index + 1}/${files.length}] ${file} — ${reason}`);
    continue;
  }

  if (result.status !== 0) {
    const reason = result.signal
      ? `signal ${result.signal}`
      : `exit ${result.status ?? "unknown"}`;
    failures.push({ file, reason });
    console.error(`\n[FAIL ${index + 1}/${files.length}] ${file} — ${reason}`);
    if (result.stdout?.trim()) {
      console.error("--- stdout ---");
      console.error(result.stdout.trim());
    }
    if (result.stderr?.trim()) {
      console.error("--- stderr ---");
      console.error(result.stderr.trim());
    }
    continue;
  }

  const suffix = stressTimeout !== undefined ? ` (${stressTimeout / 1000}s stress timeout)` : "";
  console.log(`[PASS ${index + 1}/${files.length}] ${file}${suffix}`);
}

if (failures.length > 0) {
  console.error(`\n${failures.length} of ${files.length} headless release test files failed:`);
  for (const failure of failures) {
    console.error(`- ${failure.file}: ${failure.reason}`);
  }
  process.exit(1);
}

console.log(`\nAll ${files.length} headless release test files passed.`);
