import { cpSync, mkdirSync, rmSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "..", "..", "..");
const src = process.env.UA_COPY_OPS_SRC || resolve(repoRoot, "scripts");
const dest = process.env.UA_COPY_OPS_DEST || resolve(here, "..", "dist-scripts");

// Runtime files the packaged ops scripts need at execution time. Explicit
// allowlist so we never publish test fixtures or release-gate-only helpers.
const FILES = [
  "daily-update.sh",
  "nightly-project-sync.sh",
  "refresh-prod-server.sh",
  "aggregate-daily.mjs",
  "aggregate-nightly.mjs",
  "lib/common.sh",
  "lib/discover-projects.mjs",
  "lib/upsert-project-registry.mjs",
];

rmSync(dest, { recursive: true, force: true });
for (const rel of FILES) {
  const from = resolve(src, rel);
  const to = resolve(dest, rel);
  mkdirSync(dirname(to), { recursive: true });
  cpSync(from, to);
}
process.stdout.write(`copied ops scripts -> ${dest}\n`);
