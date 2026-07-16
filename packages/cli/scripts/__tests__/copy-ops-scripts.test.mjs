import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const copyScript = resolve(here, "..", "copy-ops-scripts.mjs");

const work = mkdtempSync(resolve(tmpdir(), "ua-copy-ops-"));
try {
  const repoScripts = resolve(work, "scripts");
  mkdirSync(resolve(repoScripts, "lib", "__tests__"), { recursive: true });
  writeFileSync(resolve(repoScripts, "daily-update.sh"), "#!/usr/bin/env bash\necho daily\n");
  writeFileSync(resolve(repoScripts, "nightly-project-sync.sh"), "#!/usr/bin/env bash\necho nightly\n");
  writeFileSync(resolve(repoScripts, "refresh-prod-server.sh"), "#!/usr/bin/env bash\necho refresh\n");
  writeFileSync(resolve(repoScripts, "aggregate-daily.mjs"), "export const x = 1;\n");
  writeFileSync(resolve(repoScripts, "aggregate-nightly.mjs"), "export const y = 1;\n");
  writeFileSync(resolve(repoScripts, "lib", "common.sh"), "# common\n");
  writeFileSync(resolve(repoScripts, "lib", "discover-projects.mjs"), "export const d = 1;\n");
  writeFileSync(resolve(repoScripts, "lib", "upsert-project-registry.mjs"), "export const u = 1;\n");
  // Files that must NOT be published into the CLI package:
  writeFileSync(resolve(repoScripts, "lib", "release-gate-helpers.mjs"), "export const g = 1;\n");
  writeFileSync(resolve(repoScripts, "lib", "__tests__", "discover-projects.test.mjs"), "// test\n");
  writeFileSync(resolve(repoScripts, "write-external-records.mjs"), "// feishu-only\n");

  const pkgDir = resolve(work, "pkg");
  mkdirSync(pkgDir, { recursive: true });

  execFileSync(process.execPath, [copyScript], {
    env: { ...process.env, UA_COPY_OPS_SRC: repoScripts, UA_COPY_OPS_DEST: resolve(pkgDir, "dist-scripts") },
  });

  const dest = resolve(pkgDir, "dist-scripts");
  const mustExist = [
    "daily-update.sh",
    "nightly-project-sync.sh",
    "refresh-prod-server.sh",
    "aggregate-daily.mjs",
    "aggregate-nightly.mjs",
    "write-external-records.mjs",
    "lib/common.sh",
    "lib/discover-projects.mjs",
    "lib/upsert-project-registry.mjs",
  ];
  for (const f of mustExist) {
    assert.ok(existsSync(resolve(dest, f)), `missing ${f}`);
  }

  const mustNotExist = [
    "lib/release-gate-helpers.mjs",
    "lib/__tests__",
    "lib/__tests__/discover-projects.test.mjs",
  ];
  for (const f of mustNotExist) {
    assert.ok(!existsSync(resolve(dest, f)), `should not bundle ${f}`);
  }

  console.log("copy-ops-scripts.test.mjs: all checks passed");
} finally {
  rmSync(work, { recursive: true, force: true });
}
