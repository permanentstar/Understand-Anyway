# OSS 标准 Release 部署验证（PPE + 本地 Verdaccio）实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: 用 superpowers:subagent-driven-development（推荐）或 superpowers:executing-plans 按任务逐条实现本计划。步骤用 checkbox（`- [ ]`）跟踪。

**Goal:** 让 PPE 机器能以“标准 OSS 安装形态”部署本项目——只从 registry 安装 npm 包（含 ops 编排脚本），用 traecli/traex 作为 LLM，不依赖飞书 SSO，不在 PPE 上 git pull 源码构建 CLI。

**Architecture:** ops 编排脚本（`daily-update.sh` / `nightly-project-sync.sh` / `refresh-prod-server.sh` / `lib/` / `aggregate-*.mjs`）随 `@understand-anyway/cli` 包发布，并通过 `understand-anyway ops <script>` 子命令暴露；Verdaccio 跑在 PPE 本地（`127.0.0.1:4873`），包由本机 build 成 tarball 后 scp 到 PPE 再本地 publish；新增一个 release gate external case `ppe-oss-release` 从头验证“干净目录 → 本地 registry 安装 → 最小 deploy.yaml → build/gateway/serve/real-LLM smoke → 清理”。

**Tech Stack:** Node.js/TypeScript pnpm monorepo、tsup、bash ops 脚本、Verdaccio、SSH、traecli/traex（cli-spawn LLM provider）、`scripts/release-gate*.mjs`。

---

## 背景事实（实现前必读）

- ops 脚本用 `SCRIPT_DIR="$(dirname BASH_SOURCE)"` + `ROOT_DIR="$SCRIPT_DIR/.."` 定位同级文件，并 `source lib/common.sh`。见 [daily-update.sh](file:///Users/bytedance/WorkSpace/Project/Community/Understand-Anyway/scripts/daily-update.sh#L22-L26)。
- CLI 解析：`understand_anyway()` 优先 PATH 上的 `understand-anyway`，否则回退 `$ROOT_DIR/packages/cli/dist/cli.js`。见 [common.sh](file:///Users/bytedance/WorkSpace/Project/Community/Understand-Anyway/scripts/lib/common.sh#L106-L118)。
- CLI 包 `files` 目前只含 `dist` / `deploy.example.yaml` / `deploy.schema.json`，**不含 scripts**。见 [package.json](file:///Users/bytedance/WorkSpace/Project/Community/Understand-Anyway/packages/cli/package.json#L18-L22)。
- 现有 external runner 是 [release-gate-ppe.mjs](file:///Users/bytedance/WorkSpace/Project/Community/Understand-Anyway/scripts/release-gate-ppe.mjs)，case 列表 `PPE_CASES`，通过 `buildSshCommand` + `ssh -n` 执行；env 默认值在 [release-gate-ppe-env.sh](file:///Users/bytedance/WorkSpace/Project/Community/Understand-Anyway/scripts/release-gate-ppe-env.sh)。
- external case 注册在 [release-gate.mjs](file:///Users/bytedance/WorkSpace/Project/Community/Understand-Anyway/scripts/release-gate.mjs) 的 `EXTERNAL_CASE_ENV_VARS`。
- 已确认决策：**ops 脚本随 CLI 包发布**（不做独立 bundle、不保留最小 checkout）。

## 关键设计约定

1. 包内布局：ops 脚本发布到 CLI 包的 `dist-scripts/` 目录（发布时从 `scripts/` 拷入，保持 `daily-update.sh` / `nightly-project-sync.sh` / `refresh-prod-server.sh` / `aggregate-daily.mjs` / `aggregate-nightly.mjs` / `lib/*` 相对结构不变）。
2. 用户入口：新增 `understand-anyway ops <name> [args...]` 子命令，`name ∈ {daily-update, nightly-project-sync, refresh-prod-server}`，内部 `bash <pkgRoot>/dist-scripts/<name>.sh args...`。这样脚本内 `ROOT_DIR=dist-scripts/..=<pkgRoot>`，`understand_anyway()` 命中 PATH 上已安装的 `understand-anyway`，无需源码。
3. Verdaccio：PPE 本地起，`127.0.0.1:4873`，storage 放临时目录，跑完关停并清理。
4. 包传输：本机 `pnpm -r build` → 6 个包 `npm pack` 成 tarball → scp 到 PPE 临时目录 → PPE 本地 `npm publish <tgz> --registry http://127.0.0.1:4873`。PPE 不 build 源码。
5. LLM：沿用现有 real-llm 的 traex shim 思路，但配置写进 `deploy.yaml` 的 provider，标注是 Trae/Codebase auth，不是飞书 SSO。
6. registry 抽象：`ppe-oss-release` 支持 `UA_RELEASE_GATE_PPE_REGISTRY`，默认 `http://127.0.0.1:4873`，后续可切 public npm `next`。

---

## Task 1: ops 脚本随 CLI 包发布（打包 + files）

**Files:**
- Modify: `packages/cli/package.json:18-22`（files 增列 + 新增 prepack/复制脚本）
- Create: `packages/cli/scripts/copy-ops-scripts.mjs`
- Test: `packages/cli/scripts/__tests__/copy-ops-scripts.test.mjs`

- [ ] **Step 1: 写失败测试**

```js
// packages/cli/scripts/__tests__/copy-ops-scripts.test.mjs
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, existsSync, cpSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const copyScript = resolve(here, "..", "copy-ops-scripts.mjs");

const work = mkdtempSync(resolve(tmpdir(), "ua-copy-ops-"));
try {
  const repoScripts = resolve(work, "scripts");
  mkdirSync(resolve(repoScripts, "lib"), { recursive: true });
  writeFileSync(resolve(repoScripts, "daily-update.sh"), "#!/usr/bin/env bash\necho daily\n");
  writeFileSync(resolve(repoScripts, "nightly-project-sync.sh"), "#!/usr/bin/env bash\necho nightly\n");
  writeFileSync(resolve(repoScripts, "refresh-prod-server.sh"), "#!/usr/bin/env bash\necho refresh\n");
  writeFileSync(resolve(repoScripts, "aggregate-daily.mjs"), "export const x=1;\n");
  writeFileSync(resolve(repoScripts, "aggregate-nightly.mjs"), "export const y=1;\n");
  writeFileSync(resolve(repoScripts, "lib", "common.sh"), "# common\n");
  const pkgDir = resolve(work, "pkg");
  mkdirSync(pkgDir, { recursive: true });

  execFileSync(process.execPath, [copyScript], {
    env: { ...process.env, UA_COPY_OPS_SRC: repoScripts, UA_COPY_OPS_DEST: resolve(pkgDir, "dist-scripts") },
  });

  const dest = resolve(pkgDir, "dist-scripts");
  for (const f of ["daily-update.sh", "nightly-project-sync.sh", "refresh-prod-server.sh", "aggregate-daily.mjs", "aggregate-nightly.mjs", "lib/common.sh"]) {
    assert.ok(existsSync(resolve(dest, f)), `missing ${f}`);
  }
  console.log("copy-ops-scripts.test.mjs: all checks passed");
} finally {
  rmSync(work, { recursive: true, force: true });
}
```

- [ ] **Step 2: 运行确认失败**

Run: `node packages/cli/scripts/__tests__/copy-ops-scripts.test.mjs`
Expected: FAIL（`copy-ops-scripts.mjs` 不存在）

- [ ] **Step 3: 实现复制脚本**

```js
// packages/cli/scripts/copy-ops-scripts.mjs
import { cpSync, mkdirSync, rmSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "..", "..", "..");
const src = process.env.UA_COPY_OPS_SRC || resolve(repoRoot, "scripts");
const dest = process.env.UA_COPY_OPS_DEST || resolve(here, "..", "dist-scripts");

const ENTRIES = [
  "daily-update.sh",
  "nightly-project-sync.sh",
  "refresh-prod-server.sh",
  "aggregate-daily.mjs",
  "aggregate-nightly.mjs",
  "lib",
];

rmSync(dest, { recursive: true, force: true });
mkdirSync(dest, { recursive: true });
for (const entry of ENTRIES) {
  cpSync(resolve(src, entry), resolve(dest, entry), { recursive: true });
}
process.stdout.write(`copied ops scripts -> ${dest}\n`);
```

- [ ] **Step 4: 运行确认通过**

Run: `node packages/cli/scripts/__tests__/copy-ops-scripts.test.mjs`
Expected: PASS

- [ ] **Step 5: 接入 package.json（prepack + files）**

`packages/cli/package.json`：
- `files` 增加 `"dist-scripts"`。
- `scripts` 增加 `"prepack": "node scripts/copy-ops-scripts.mjs"`。

- [ ] **Step 6: 验证打包内容含脚本**

Run: `cd packages/cli && node scripts/copy-ops-scripts.mjs && npm pack --dry-run 2>&1 | grep -E "dist-scripts/(daily-update.sh|lib/common.sh)"`
Expected: 两个路径都出现在 pack 文件清单里

- [ ] **Step 7: 提交**

```bash
git add packages/cli/package.json packages/cli/scripts/copy-ops-scripts.mjs packages/cli/scripts/__tests__/copy-ops-scripts.test.mjs
git commit -m "feat(cli): bundle ops scripts into published package"
```

---

## Task 2: `understand-anyway ops <name>` 子命令

**Files:**
- Modify: `packages/cli/src/cli.ts`（注册 `ops` 命令；确认现有命令分发风格后插入）
- Create: `packages/cli/src/ops/run-ops-script.ts`
- Test: `packages/cli/src/ops/run-ops-script.test.ts`

- [ ] **Step 1: 写失败测试**

```ts
// packages/cli/src/ops/run-ops-script.test.ts
import { describe, it, expect } from "vitest";
import { resolveOpsScriptPath, OPS_SCRIPTS } from "./run-ops-script";

describe("resolveOpsScriptPath", () => {
  it("maps known names to dist-scripts path", () => {
    const p = resolveOpsScriptPath("daily-update", "/pkg");
    expect(p).toBe("/pkg/dist-scripts/daily-update.sh");
  });
  it("rejects unknown names", () => {
    expect(() => resolveOpsScriptPath("rm-rf", "/pkg")).toThrow(/unknown ops script/);
  });
  it("exposes the three ops entrypoints", () => {
    expect(OPS_SCRIPTS).toEqual(["daily-update", "nightly-project-sync", "refresh-prod-server"]);
  });
});
```

- [ ] **Step 2: 运行确认失败**

Run: `pnpm --filter @understand-anyway/cli test -- run src/ops/run-ops-script.test.ts`
Expected: FAIL（模块不存在）

- [ ] **Step 3: 实现 resolver + 执行器**

```ts
// packages/cli/src/ops/run-ops-script.ts
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const OPS_SCRIPTS = ["daily-update", "nightly-project-sync", "refresh-prod-server"] as const;
export type OpsScript = (typeof OPS_SCRIPTS)[number];

export function packageRoot(): string {
  // dist/cli.js -> package root is one level up from dist/
  return resolve(dirname(fileURLToPath(import.meta.url)), "..");
}

export function resolveOpsScriptPath(name: string, pkgRoot: string): string {
  if (!(OPS_SCRIPTS as readonly string[]).includes(name)) {
    throw new Error(`unknown ops script: ${name} (expected ${OPS_SCRIPTS.join(", ")})`);
  }
  return resolve(pkgRoot, "dist-scripts", `${name}.sh`);
}

export function runOpsScript(name: string, args: string[]): number {
  const pkgRoot = packageRoot();
  const scriptPath = resolveOpsScriptPath(name, pkgRoot);
  if (!existsSync(scriptPath)) {
    process.stderr.write(`ops script missing in package: ${scriptPath}\n`);
    return 127;
  }
  const res = spawnSync("bash", [scriptPath, ...args], { stdio: "inherit" });
  return res.status ?? 1;
}
```

- [ ] **Step 4: 运行确认通过**

Run: `pnpm --filter @understand-anyway/cli test -- run src/ops/run-ops-script.test.ts`
Expected: PASS

- [ ] **Step 5: 在 cli.ts 注册 `ops` 命令**

在 `packages/cli/src/cli.ts` 的命令分发处按现有风格加入：解析 `argv` 第一个位置参数为 `<name>`，其余透传给 `runOpsScript(name, rest)`，用其返回值 `process.exit`。（实现前先读 cli.ts 现有 dispatch，套用相同 pattern，勿新造框架。）

- [ ] **Step 6: build 后端到端验证子命令**

Run:
```bash
pnpm --filter @understand-anyway/cli build
node packages/cli/scripts/copy-ops-scripts.mjs
node packages/cli/dist/cli.js ops daily-update --help
```
Expected: 打印 daily-update.sh 的 usage（退出 0）

- [ ] **Step 7: 提交**

```bash
git add packages/cli/src/cli.ts packages/cli/src/ops/run-ops-script.ts packages/cli/src/ops/run-ops-script.test.ts
git commit -m "feat(cli): add 'ops' subcommand to run bundled ops scripts"
```

---

## Task 3: PPE 本地 Verdaccio + tarball 发布脚本

**Files:**
- Create: `scripts/release-gate-ppe-verdaccio.mjs`（本机侧：build → pack → scp → 远端 publish 到本地 Verdaccio）
- Test: `scripts/__tests__/release-gate-ppe-verdaccio.test.mjs`（纯 dry-run 契约测试，不连 PPE）

- [ ] **Step 1: 写失败测试（dry-run 命令契约）**

```js
// scripts/__tests__/release-gate-ppe-verdaccio.test.mjs
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const script = resolve(repoRoot, "scripts", "release-gate-ppe-verdaccio.mjs");

function run(args, env = {}) {
  return spawnSync(process.execPath, [script, ...args], {
    cwd: repoRoot, encoding: "utf8",
    env: { ...process.env, ...env },
  });
}

{
  const r = run(["--dry-run"], {
    UA_RELEASE_GATE_PPE_HOST: "10.0.0.1",
    UA_RELEASE_GATE_PPE_USER: "tester",
    UA_RELEASE_GATE_PPE_ROOT: "/tmp/ua-ppe",
  });
  assert.equal(r.status, 0, r.stderr || r.stdout);
  assert.match(r.stdout, /verdaccio/i);
  assert.match(r.stdout, /127\.0\.0\.1:4873/);
  assert.match(r.stdout, /npm publish/);
  assert.match(r.stdout, /ssh -n -o BatchMode=yes/);
}
console.log("release-gate-ppe-verdaccio.test.mjs: all checks passed");
```

- [ ] **Step 2: 运行确认失败**

Run: `node scripts/__tests__/release-gate-ppe-verdaccio.test.mjs`
Expected: FAIL（脚本不存在）

- [ ] **Step 3: 实现发布脚本**

要点（实现时严格照此，勿加多余能力）：
- 读 env：`UA_RELEASE_GATE_PPE_HOST/USER/ROOT`，可选 `UA_RELEASE_GATE_PPE_REGISTRY`（默认 `http://127.0.0.1:4873`）、`UA_RELEASE_GATE_PPE_VERDACCIO_STORAGE`（默认远端 `<ROOT>/verdaccio-storage`）。
- `--dry-run` 时只打印计划命令并退出 0。
- 真实执行顺序：
  1. 本机 `pnpm -r build`。
  2. 对 6 个包（plugin-api, core, gateway, provider-feishu-auth, provider-feishu-sheets, cli）依赖序执行 `npm pack`，得 tarball 列表。
  3. `ssh -n` 在 PPE 建临时目录 + 启动本地 Verdaccio（`npx verdaccio --config <tmp>/config.yaml --listen 127.0.0.1:4873`，后台，写 pid）。
  4. `scp` tarball 到 PPE 临时目录。
  5. `ssh -n` 在 PPE 依赖序 `npm publish <tgz> --registry http://127.0.0.1:4873`。
  6. 打印 registry URL 供后续 case 使用。
- 复用 [release-gate-helpers.mjs](file:///Users/bytedance/WorkSpace/Project/Community/Understand-Anyway/scripts/lib/release-gate-helpers.mjs) 的 `run`；SSH 一律 `ssh -n -o BatchMode=yes`。

- [ ] **Step 4: 运行确认通过**

Run: `node scripts/__tests__/release-gate-ppe-verdaccio.test.mjs`
Expected: PASS

- [ ] **Step 5: 真机冒烟（人工确认，不进自动门禁）**

Run: `source scripts/release-gate-ppe-env.sh && node scripts/release-gate-ppe-verdaccio.mjs`
Expected: PPE 上 Verdaccio 起来、6 包 publish 成功；结束后 pid/storage 可被后续 case 或清理步骤回收。

- [ ] **Step 6: 提交**

```bash
git add scripts/release-gate-ppe-verdaccio.mjs scripts/__tests__/release-gate-ppe-verdaccio.test.mjs
git commit -m "feat(release-gate): add PPE-local verdaccio publish helper"
```

---

## Task 4: 新增 external case `ppe-oss-release`

**Files:**
- Modify: `scripts/release-gate-ppe.mjs`（加入 `ppe-oss-release` case + builder）
- Modify: `scripts/release-gate.mjs`（`EXTERNAL_CASE_ENV_VARS` 注册）
- Modify: `scripts/release-gate-ppe-env.sh`（默认 external cmd + registry 默认值）
- Modify: `scripts/__tests__/release-gate-ppe.test.mjs`（新增契约断言）

- [ ] **Step 1: 写失败测试（契约）**

在 `scripts/__tests__/release-gate-ppe.test.mjs` 追加：
```js
{
  const result = run(["--case", "ppe-oss-release", "--dry-run"], {
    UA_RELEASE_GATE_PPE_HOST: "10.0.0.1",
    UA_RELEASE_GATE_PPE_USER: "tester",
    UA_RELEASE_GATE_PPE_ROOT: "/tmp/ua-ppe",
    UA_RELEASE_GATE_PPE_PLUGIN_ROOT: "/tmp/plugin",
    UA_RELEASE_GATE_PPE_TRAEX_BIN: "/tmp/bin/traex",
  });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.match(result.stdout, /npm (install|i) .*@understand-anyway\/cli/);
  assert.match(result.stdout, /--registry http:\/\/127\.0\.0\.1:4873/);
  assert.match(result.stdout, /understand-anyway ops daily-update/);
  assert.doesNotMatch(result.stdout, /git pull/);
}
```

- [ ] **Step 2: 运行确认失败**

Run: `node scripts/__tests__/release-gate-ppe.test.mjs`
Expected: FAIL（`ppe-oss-release` 未知 case）

- [ ] **Step 3: 实现 case**

在 `scripts/release-gate-ppe.mjs`：
- `PPE_CASES` 追加 `"ppe-oss-release"`。
- 新增 `buildOssReleaseCommand(env)`：干净临时目录 → `npm install -g`（或本地 prefix 安装）`@understand-anyway/cli --registry <registry>` → 写最小 `deploy.yaml`（provider llm = cli-spawn/traex，profile small，`llmRequired:false`）→ `understand-anyway ops daily-update --project ... --profile small --deploy-profile ppe --host <host> --port 18690 --no-self-update`（注意标准形态无 `--no-pull` 需求，因为不涉及源码 repo）→ gateway/serve/endpoint smoke → 清理端口与临时目录。registry 取 `env.registry`（默认 `http://127.0.0.1:4873`）。
- LLM 走已验证的 traex shim（复用 `buildRealLlmShimCommand` 的 shim 生成逻辑，抽出公共函数）。
- `buildCommand` switch 增加分支。

- [ ] **Step 4: 运行确认通过**

Run: `node scripts/__tests__/release-gate-ppe.test.mjs`
Expected: PASS

- [ ] **Step 5: 注册到 release gate + env bootstrap**

- `scripts/release-gate.mjs` 的 `EXTERNAL_CASE_ENV_VARS` 加 `"ppe-oss-release": "UA_RELEASE_GATE_EXTERNAL_PPE_OSS_RELEASE_CMD"`。
- `scripts/release-gate-ppe-env.sh` 加默认：
  ```bash
  : "${UA_RELEASE_GATE_PPE_REGISTRY:=http://127.0.0.1:4873}"
  : "${UA_RELEASE_GATE_EXTERNAL_PPE_OSS_RELEASE_CMD:=node '$__ua_ppe_env_repo_root/scripts/release-gate-ppe.mjs' --case ppe-oss-release}"
  ```

- [ ] **Step 6: env 契约测试补充**

在 `scripts/__tests__/release-gate-ppe-env.test.mjs` 加断言：`UA_RELEASE_GATE_PPE_REGISTRY` 默认 `http://127.0.0.1:4873`，`UA_RELEASE_GATE_EXTERNAL_PPE_OSS_RELEASE_CMD` 以 `--case ppe-oss-release` 结尾。

- [ ] **Step 7: 运行脚本测试套件**

Run: `pnpm test:scripts`
Expected: all passed

- [ ] **Step 8: 提交**

```bash
git add scripts/release-gate-ppe.mjs scripts/release-gate.mjs scripts/release-gate-ppe-env.sh scripts/__tests__/release-gate-ppe.test.mjs scripts/__tests__/release-gate-ppe-env.test.mjs
git commit -m "feat(release-gate): add ppe-oss-release external case (verdaccio install + ops + real-llm)"
```

---

## Task 5: 编排 Verdaccio 生命周期进 `ppe-oss-release`

**Files:**
- Modify: `scripts/release-gate-ppe.mjs`（`ppe-oss-release` 前置起 Verdaccio+publish，后置 stop+清理）
- Test: 复用 Task 4 契约测试 + 真机冒烟

- [ ] **Step 1: 在 case 内串接 publish**

`ppe-oss-release` 远端命令序列前置：调用 Task 3 的 publish 能力（可在本机侧先跑 `release-gate-ppe-verdaccio.mjs` 再触发远端 install；或把 Verdaccio 起停封装成远端命令段）。约束：Verdaccio storage、pid、临时安装目录全部在 PPE 临时路径，case 结束 `trap`/finally 里 stop 并 `rm -rf`。

- [ ] **Step 2: dry-run 仍绿**

Run: `node scripts/__tests__/release-gate-ppe.test.mjs`
Expected: PASS

- [ ] **Step 3: 真机单 case 冒烟**

Run: `source scripts/release-gate-ppe-env.sh && node scripts/release-gate-ppe.mjs --case ppe-oss-release`
Expected: 干净目录从本地 Verdaccio 装包 → build/gateway/serve/real-LLM smoke 通过 → Verdaccio 与端口清理干净。

- [ ] **Step 4: 端口/进程残留复查**

Run: `ssh -n -o BatchMode=yes "$UA_RELEASE_GATE_PPE_USER@$UA_RELEASE_GATE_PPE_HOST" "lsof -nP -iTCP:4873 -sTCP:LISTEN || true; lsof -nP -iTCP:18690 -sTCP:LISTEN || true"`
Expected: 无输出（无残留）

- [ ] **Step 5: 提交**

```bash
git add scripts/release-gate-ppe.mjs
git commit -m "feat(release-gate): wire verdaccio lifecycle into ppe-oss-release"
```

---

## Task 6: 文档 + 全门禁验收

**Files:**
- Modify: `docs/release-tests/external/ppe/runbook.md`
- Modify: `docs/release-tests/external/README.md`
- Modify: `docs/deployment-cli.md`（新增 `understand-anyway ops <name>` 与标准安装说明）

- [ ] **Step 1: 更新 runbook**

写清标准 OSS 形态命令：
```bash
source scripts/release-gate-ppe-env.sh
pnpm run release:gate -- --external ppe-oss-release
```
并说明：Verdaccio 本地起、包由本机 tarball 传入、LLM 用 traex（Trae/Codebase auth，非飞书 SSO）、ops 脚本随包发布。

- [ ] **Step 2: 文档化 ops 子命令**

在 `docs/deployment-cli.md` 增加 `understand-anyway ops daily-update|nightly-project-sync|refresh-prod-server` 用法与最小 `deploy.yaml` 示例（traex provider）。

- [ ] **Step 3: 全门禁（本地 + 全部 external，含新 case）**

Run:
```bash
source scripts/release-gate-ppe-env.sh
pnpm run release:gate -- --external ppe-repo --external ppe-npm-installed --external ppe-ops --external ppe-real-llm --external ppe-oss-release
```
Expected: `.release-gate/<run-id>/summary.json` 的 `overallStatus=success`，新 case `ppe-oss-release` status=success。

- [ ] **Step 4: 清理复查**

Run: 复查本地与 PPE 的 `4873/18666/18672/18690` 均无监听；无 `release-gate*/local-delivery/verdaccio/dashboard-server` 残留进程。

- [ ] **Step 5: 提交**

```bash
git add docs/release-tests/external/ppe/runbook.md docs/release-tests/external/README.md docs/deployment-cli.md
git commit -m "docs: standard OSS release deploy via ppe-oss-release + ops subcommand"
```

---

## Self-Review 结论

- Spec 覆盖：ops 随包发布(Task1/2)、PPE 本地 Verdaccio(Task3)、tarball 传输(Task3)、标准安装 case(Task4/5)、traex LLM 非飞书(Task4)、不 git pull 源码(Task4 断言 `doesNotMatch git pull`)、文档+全门禁(Task6) 均有任务。
- 类型/命名一致：`OPS_SCRIPTS`、`resolveOpsScriptPath`、`runOpsScript`、`ppe-oss-release`、`UA_RELEASE_GATE_PPE_REGISTRY`、`UA_RELEASE_GATE_EXTERNAL_PPE_OSS_RELEASE_CMD` 前后一致。
- 待实现时确认项（非 placeholder，是需读现有代码套用的点）：`cli.ts` 现有命令 dispatch 风格（Task2 Step5）、`buildRealLlmShimCommand` 抽公共 shim 函数（Task4 Step3）。

## 未纳入本计划（后续单独决策）

- public npm `next` dist-tag 发布与 `release.mjs --tag next`：等 `ppe-oss-release`(Verdaccio) 全绿后再单开计划。
- GitHub private→public 前的最终 review / squash / force push。
