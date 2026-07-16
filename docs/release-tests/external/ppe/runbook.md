# external / ppe / runbook

PPE 套件通过 `release:gate` 显式请求：

```bash
pnpm run release:gate -- --external ppe-repo
pnpm run release:gate -- --external ppe-npm-installed
pnpm run release:gate -- --external ppe-ops
pnpm run release:gate -- --external ppe-real-llm
pnpm run release:gate -- --external ppe-oss-release
```

推荐用法：

```bash
source scripts/release-gate-ppe-env.sh
pnpm run release:gate -- --external ppe-repo --external ppe-npm-installed --external ppe-ops --external ppe-real-llm --external ppe-oss-release
```

`scripts/release-gate-ppe-env.sh` 会导出 PPE 默认机器、目录、插件根目录、`traex` 路径、`registry`，以及 5 个 `release:gate` external case 命令。

脚本入口：

- 默认入口是仓库内脚本：

```bash
node scripts/release-gate-ppe.mjs --case ppe-repo
node scripts/release-gate-ppe.mjs --case ppe-npm-installed
node scripts/release-gate-ppe.mjs --case ppe-ops
node scripts/release-gate-ppe.mjs --case ppe-real-llm
node scripts/release-gate-ppe.mjs --case ppe-oss-release
```

- `release:gate` 外部 case 仍可通过环境变量覆盖成任意命令。

手动覆盖示例：

```bash
export UA_RELEASE_GATE_EXTERNAL_PPE_REPO_CMD='node scripts/release-gate-ppe.mjs --case ppe-repo'
export UA_RELEASE_GATE_EXTERNAL_PPE_NPM_INSTALLED_CMD='node scripts/release-gate-ppe.mjs --case ppe-npm-installed'
export UA_RELEASE_GATE_EXTERNAL_PPE_OPS_CMD='node scripts/release-gate-ppe.mjs --case ppe-ops'
export UA_RELEASE_GATE_EXTERNAL_PPE_REAL_LLM_CMD='node scripts/release-gate-ppe.mjs --case ppe-real-llm'
export UA_RELEASE_GATE_EXTERNAL_PPE_OSS_RELEASE_CMD='node scripts/release-gate-ppe.mjs --case ppe-oss-release'
```

推荐环境变量：

- `UA_RELEASE_GATE_PPE_HOST`
- `UA_RELEASE_GATE_PPE_USER`
- `UA_RELEASE_GATE_PPE_ROOT`
- `UA_RELEASE_GATE_PPE_PLUGIN_ROOT`
- `UA_RELEASE_GATE_EXTERNAL_PPE_REPO_CMD`
- `UA_RELEASE_GATE_EXTERNAL_PPE_NPM_INSTALLED_CMD`
- `UA_RELEASE_GATE_EXTERNAL_PPE_OPS_CMD`
- `UA_RELEASE_GATE_EXTERNAL_PPE_REAL_LLM_CMD`
- `UA_RELEASE_GATE_EXTERNAL_PPE_OSS_RELEASE_CMD`

可选环境变量：

- `UA_RELEASE_GATE_PPE_REPO_DIR`
- `UA_RELEASE_GATE_PPE_REPO_PROJECTS_ROOT`
- `UA_RELEASE_GATE_PPE_NPM_DIR`
- `UA_RELEASE_GATE_PPE_TRAEX_BIN`
- `UA_RELEASE_GATE_PPE_REGISTRY`（默认 `http://127.0.0.1:4873`，仅 `ppe-oss-release`）
- `UA_RELEASE_GATE_PPE_VERDACCIO_STORAGE` / `UA_RELEASE_GATE_PPE_TARBALL_DIR`

`ppe-real-llm` 额外前置：

- PPE 机器已安装 `traex`
- `traex login --git-code` 可成功完成
- 脚本会临时写入一个 `llm` shim，把 `@understand-anyway/provider-trae-cli-v2` 接到 `traex exec`

`ppe-oss-release` 验证标准 OSS 安装形态，额外行为：

- 控制端本机 `pnpm -r build` + `pnpm pack` 10 个包（`pnpm pack` 会把
  `workspace:*` 依赖解析成真实版本号；`npm pack` 不会，会导致 publish 报
  `EUNSUPPORTEDPROTOCOL`），再 `scp` 到 PPE 的 `verdaccio-tarballs/`。
- 部署会话：PPE 本地起 Verdaccio（`setsid` 脱离 ssh channel）→ 写 scoped
  `.npmrc` token → `npm publish` 6 个包 → `npm install @understand-anyway/cli`
  → `understand-anyway init` → `understand-anyway ops daily-update`
  （build + gateway publish + dashboard，LLM 走 traex）→ 干净 `exit 0`。
- teardown 会话（独立 ssh）：`gateway stop` + kill Verdaccio（从端口解析真实
  pid）+ 删除固定 workRoot `/tmp/ua-ppe-oss-release`。拆分两会话是因为在部署
  会话内停止自己派生的 dashboard daemon 会 half-close ssh channel，误报 255。
- smoke fixture 是两个模块（`index.js` import `greet.js`），产生真实 import
  边，避免 graph-health gate 因 `imports_edges_missing` 拒绝。
- 成功标志：远端日志出现 `[ppe-oss-release] deploy ok` 与
  `[ppe-oss-release] teardown ok`，且命令干净 `exit 0`、PPE 无端口/进程/目录残留。
