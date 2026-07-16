import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const OPS_SCRIPTS = ["daily-update", "nightly-project-sync", "refresh-prod-server"] as const;
export type OpsScript = (typeof OPS_SCRIPTS)[number];

/** Package root = one level up from dist/cli.js (published) or dist/ (built). */
export function packageRoot(): string {
  return resolve(dirname(fileURLToPath(import.meta.url)), "..");
}

export function resolveOpsScriptPath(name: string, pkgRoot: string): string {
  if (!(OPS_SCRIPTS as readonly string[]).includes(name)) {
    throw new Error(`unknown ops script: ${name} (expected ${OPS_SCRIPTS.join(", ")})`);
  }
  return resolve(pkgRoot, "dist-scripts", `${name}.sh`);
}

export function runOpsScript(name: string, args: string[]): number {
  const scriptPath = resolveOpsScriptPath(name, packageRoot());
  if (!existsSync(scriptPath)) {
    process.stderr.write(`ops script missing in package: ${scriptPath}\n`);
    return 127;
  }
  const res = spawnSync("bash", [scriptPath, ...args], { stdio: "inherit" });
  if (typeof res.status === "number") return res.status;
  return 1;
}
