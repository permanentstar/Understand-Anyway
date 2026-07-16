import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const script = resolve(repoRoot, "scripts", "release-gate-ppe-verdaccio.mjs");

function run(args, env = {}) {
  return spawnSync(process.execPath, [script, ...args], {
    cwd: repoRoot,
    encoding: "utf8",
    env: { ...process.env, ...env },
  });
}

// --help
{
  const r = run(["--help"]);
  assert.equal(r.status, 0, r.stderr || r.stdout);
  assert.match(r.stdout, /release-gate-ppe-verdaccio\.mjs/);
  assert.match(r.stdout, /--dry-run/);
}

// Missing required env -> exit 2 with a clear message.
{
  const r = run(["--dry-run"], { UA_RELEASE_GATE_PPE_HOST: "" });
  assert.equal(r.status, 2, r.stderr || r.stdout);
  assert.match(r.stderr, /missing UA_RELEASE_GATE_PPE_HOST/);
}

// Dry-run prints the full plan: build/pack locally, start verdaccio on PPE,
// scp tarballs, publish in dependency order over `ssh -n`.
{
  const r = run(["--dry-run"], {
    UA_RELEASE_GATE_PPE_HOST: "10.0.0.1",
    UA_RELEASE_GATE_PPE_USER: "tester",
    UA_RELEASE_GATE_PPE_ROOT: "/tmp/ua-ppe",
  });
  assert.equal(r.status, 0, r.stderr || r.stdout);
  assert.match(r.stdout, /verdaccio/i);
  assert.match(r.stdout, /127\.0\.0\.1:4873/);
  assert.match(r.stdout, /pnpm -r build/);
  assert.match(r.stdout, /npm pack/);
  assert.match(r.stdout, /scp/);
  assert.match(r.stdout, /npm publish/);
  assert.match(r.stdout, /ssh -n -o BatchMode=yes/);

  // Publish order must be dependency-first, cli last.
  const idxPluginApi = r.stdout.indexOf("plugin-api");
  const idxCli = r.stdout.indexOf("understand-anyway-cli");
  assert.ok(idxPluginApi >= 0, "plugin-api tarball referenced");
  assert.ok(idxCli > idxPluginApi, "cli published after plugin-api");
}

// Registry override is honored.
{
  const r = run(["--dry-run"], {
    UA_RELEASE_GATE_PPE_HOST: "10.0.0.1",
    UA_RELEASE_GATE_PPE_USER: "tester",
    UA_RELEASE_GATE_PPE_ROOT: "/tmp/ua-ppe",
    UA_RELEASE_GATE_PPE_REGISTRY: "http://127.0.0.1:4999",
  });
  assert.equal(r.status, 0, r.stderr || r.stdout);
  assert.match(r.stdout, /127\.0\.0\.1:4999/);
}

console.log("release-gate-ppe-verdaccio.test.mjs: all checks passed");
