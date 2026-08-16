import { createHash } from "node:crypto";
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const releaseDir = join(root, "release");
const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
const base = `mcsmartbot-v${pkg.version}-headless`;
const stage = join(releaseDir, base);
const tarPath = join(releaseDir, `${base}.tar.gz`);
function run(command, args) {
  const result = spawnSync(command, args, { cwd: root, stdio: "inherit" });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`${command} failed with exit code ${result.status}`);
}
rmSync(stage, { recursive: true, force: true });
rmSync(tarPath, { force: true });
mkdirSync(stage, { recursive: true });
cpSync(join(root, "dist"), join(stage, "dist"), { recursive: true });
for (const file of [".env.example", "server.example.json", "smartbot.example.json", "SECURITY.md", "THIRD_PARTY_NOTICES.md", "HEADLESS_RELEASE.md"]) {
  const source = join(root, file);
  if (existsSync(source)) cpSync(source, join(stage, file), { recursive: true });
}
writeFileSync(join(stage, "package.json"), JSON.stringify({ ...pkg, scripts: { start: "node dist/index.js" } }, null, 2) + "\n");
run(process.platform === "win32" ? "tar.exe" : "tar", ["-czf", tarPath, "-C", releaseDir, base]);
const checksum = createHash("sha256").update(readFileSync(tarPath)).digest("hex");
writeFileSync(`${tarPath}.sha256`, `${checksum}  ${base}.tar.gz\n`);
console.log(`Headless release: ${relative(root, tarPath)}`);
