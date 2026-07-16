#!/usr/bin/env node
// scripts/regression-daily-update.mjs
//
// Regression: assert daily-update.sh invokes its sub-stages in the documented
// order. This fixture runs with --no-self-update and no nightly aggregate, so
// notify is skipped; the asserted path is gateway gate -> nightly -> refresh
// -> aggregate-daily. Each shim writes its stage marker to a single shared log
// file; we then check the order of markers, not their textual content.
//
// Run: `node scripts/regression-daily-update.mjs`

import { spawnSync } from "node:child_process";
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  rmSync,
  chmodSync,
  cpSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(SCRIPT_DIR, "..");
const SCRIPT = resolve(REPO_ROOT, "scripts", "daily-update.sh");

const work = mkdtempSync(resolve(tmpdir(), "ua-daily-regression-"));
let exitCode = 0;
try {
  const isolatedRoot = resolve(work, "ua");
  const isolatedScripts = resolve(isolatedRoot, "scripts");
  mkdirSync(resolve(isolatedScripts, "lib"), { recursive: true });
  cpSync(resolve(REPO_ROOT, "scripts", "lib"), resolve(isolatedScripts, "lib"), { recursive: true });
  cpSync(SCRIPT, resolve(isolatedScripts, "daily-update.sh"));
  chmodSync(resolve(isolatedScripts, "daily-update.sh"), 0o755);

  const orderLog = resolve(work, "order.log");

  const stageShim = (marker, exitStatus = 0) =>
    `#!/usr/bin/env bash\nprintf '%s\\n' "${marker}" >> "${orderLog}"\nexit ${exitStatus}\n`;

  writeFileSync(resolve(isolatedScripts, "nightly-project-sync.sh"), stageShim("STAGE:nightly"));
  writeFileSync(resolve(isolatedScripts, "refresh-prod-server.sh"), stageShim("STAGE:refresh"));
  chmodSync(resolve(isolatedScripts, "nightly-project-sync.sh"), 0o755);
  chmodSync(resolve(isolatedScripts, "refresh-prod-server.sh"), 0o755);

  // aggregate-daily shim: writes its marker to the order log and exits 0.
  writeFileSync(
    resolve(isolatedScripts, "aggregate-daily.mjs"),
    `#!/usr/bin/env node\nimport { appendFileSync } from "node:fs";\nappendFileSync("${orderLog}", "STAGE:aggregate-daily\\n");\n`,
  );
  chmodSync(resolve(isolatedScripts, "aggregate-daily.mjs"), 0o755);

  // Init isolated git repo so `git rev-parse HEAD` succeeds in self-update.
  spawnSync("git", ["init", "-q"], { cwd: isolatedRoot });
  spawnSync("git", ["config", "user.email", "test@example.com"], { cwd: isolatedRoot });
  spawnSync("git", ["config", "user.name", "test"], { cwd: isolatedRoot });
  writeFileSync(resolve(isolatedRoot, "package.json"), JSON.stringify({ name: "x" }));
  spawnSync("git", ["add", "-A"], { cwd: isolatedRoot });
  spawnSync("git", ["commit", "-q", "-m", "init"], { cwd: isolatedRoot });

  const binDir = resolve(work, "fakebin");
  mkdirSync(binDir, { recursive: true });

  // pnpm shim records install/build markers so we can assert they happen
  // before gateway/nightly.
  writeFileSync(
    resolve(binDir, "pnpm"),
    `#!/usr/bin/env bash\nprintf 'STAGE:pnpm-%s\\n' "$1" >> "${orderLog}"\nexit 0\n`,
  );

  // understand-anyway shim: gateway list returns null current (forces publish);
  // gateway publish records its marker.
  writeFileSync(
    resolve(binDir, "understand-anyway"),
    `#!/usr/bin/env bash\n` +
      `if [[ "$1" == "gateway" && "$2" == "list" ]]; then\n` +
      `  printf 'STAGE:gw-list\\n' >> "${orderLog}"\n` +
      `  printf '[]'\n` +
      `  exit 0\n` +
      `fi\n` +
      `if [[ "$1" == "gateway" && "$2" == "publish" ]]; then\n` +
      `  printf 'STAGE:gw-publish\\n' >> "${orderLog}"\n` +
      `  exit 0\n` +
      `fi\n` +
      `exit 0\n`,
  );
  chmodSync(resolve(binDir, "pnpm"), 0o755);
  chmodSync(resolve(binDir, "understand-anyway"), 0o755);

  // Use --no-self-update here so the fixture focuses on daily-update's owned
  // orchestration after self-update: gateway -> nightly -> refresh -> aggregate.

  const env = {
    ...process.env,
    PATH: `${binDir}:${process.env.PATH}`,
    UA_PROJECTS_ROOT: resolve(work, "projects"),
    UA_DEPLOY_PROFILE: "ppe",
    UA_DAILY_UPDATE_PLAIN_LOG: "true",
    HOME: work,
  };
  const result = spawnSync(
    "bash",
    [resolve(isolatedScripts, "daily-update.sh"), "--no-self-update", "--host", "h", "--port", "1"],
    { encoding: "utf8", env },
  );

  if (result.status !== 0) {
    process.stderr.write(`daily-update exited ${result.status}\nstderr=${result.stderr}\n`);
    exitCode = 1;
  }

  const order = readFileSync(orderLog, "utf8")
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);

  // Expected order under --no-self-update with no current gateway release:
  //   STAGE:gw-list -> STAGE:gw-publish -> STAGE:nightly -> STAGE:refresh -> STAGE:aggregate-daily
  const expected = ["STAGE:gw-list", "STAGE:gw-publish", "STAGE:nightly", "STAGE:refresh", "STAGE:aggregate-daily"];
  let cursor = 0;
  for (const want of expected) {
    const found = order.indexOf(want, cursor);
    if (found < 0) {
      process.stderr.write(
        `  FAIL expected ${want} after index ${cursor}, got order=\n  ${order.join("\n  ")}\n`,
      );
      exitCode = 1;
      break;
    }
    process.stdout.write(`  ok  ${want} at index ${found}\n`);
    cursor = found + 1;
  }

  if (exitCode === 0) {
    process.stdout.write("\nregression-daily-update: orchestration order verified\n");
  } else {
    process.stdout.write("\nregression-daily-update: FAILED\n");
  }
} finally {
  rmSync(work, { recursive: true, force: true });
}

process.exit(exitCode);
