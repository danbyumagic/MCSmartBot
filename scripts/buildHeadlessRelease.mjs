import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import {
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const releaseDir = join(root, "release");
const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
const artifactBase = `mcsmartbot-v${pkg.version}-headless`;
const stageDir = join(releaseDir, artifactBase);
const tarPath = join(releaseDir, `${artifactBase}.tar.gz`);
const checksumPath = `${tarPath}.sha256`;

function run(command, args) {
  const result = spawnSync(command, args, {
    cwd: root,
    stdio: "inherit",
    shell: false,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(`${command} ${args.join(" ")} failed with exit code ${result.status}`);
  }
}

function copyIfPresent(source, destination) {
  if (!existsSync(source)) return;
  mkdirSync(dirname(destination), { recursive: true });
  cpSync(source, destination, { recursive: true });
}

function walk(dir) {
  const files = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const absolute = join(dir, entry.name);
    if (entry.isDirectory()) files.push(...walk(absolute));
    else files.push(absolute);
  }
  return files;
}

rmSync(stageDir, { recursive: true, force: true });
rmSync(tarPath, { force: true });
rmSync(checksumPath, { force: true });
mkdirSync(stageDir, { recursive: true });

const distDir = join(root, "dist");
if (!existsSync(distDir)) {
  throw new Error("dist/ is missing; run npm run build before creating the release archive");
}
cpSync(distDir, join(stageDir, "dist"), { recursive: true });

for (const file of [
  "package-lock.json",
  "server.example.json",
  "smartbot.example.json",
  "SECURITY.md",
  "THIRD_PARTY_NOTICES.md",
  "HEADLESS_RELEASE.md",
]) {
  copyIfPresent(join(root, file), join(stageDir, file));
}
copyIfPresent(join(root, "LICENSES"), join(stageDir, "LICENSES"));
copyIfPresent(
  join(root, "docs", "upstream-reuse.json"),
  join(stageDir, "docs", "upstream-reuse.json"),
);

const envPath = join(root, ".env.example");
if (existsSync(envPath)) {
  const env = readFileSync(envPath, "utf8").replace(
    /DASHBOARD_ENABLED=true/g,
    "DASHBOARD_ENABLED=false",
  );
  writeFileSync(join(stageDir, ".env.example"), env);
}

const releasePackage = {
  ...pkg,
  main: "dist/index.js",
  scripts: {
    start: "node dist/index.js",
  },
};
writeFileSync(
  join(stageDir, "package.json"),
  `${JSON.stringify(releasePackage, null, 2)}\n`,
);

if (!existsSync(join(stageDir, "package-lock.json"))) {
  throw new Error("package-lock.json is required for a reproducible headless release");
}

const forbidden = [
  /(^|\/)desktop(\/|$)/i,
  /(^|\/)skills\/combat(\/|$)/i,
  /(^|\/)assets(\/|$)/i,
  /(^|\/)\.vite(\/|$)/i,
  /forge\.config/i,
  /vite\.(main|preload|renderer)\.config/i,
];
const violations = walk(stageDir)
  .map((file) => relative(stageDir, file).replaceAll("\\", "/"))
  .filter((file) => forbidden.some((pattern) => pattern.test(file)));
if (violations.length > 0) {
  throw new Error(`headless archive contains deferred payload:\n${violations.join("\n")}`);
}

const tarCommand = process.platform === "win32" ? "tar.exe" : "tar";
run(tarCommand, ["-czf", tarPath, "-C", releaseDir, artifactBase]);

const checksum = createHash("sha256").update(readFileSync(tarPath)).digest("hex");
writeFileSync(checksumPath, `${checksum}  ${artifactBase}.tar.gz\n`);

console.log(`Headless release: ${relative(root, tarPath)}`);
console.log(`SHA-256: ${checksum}`);
