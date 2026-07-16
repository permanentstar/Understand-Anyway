# external / ppe / runbook

PPE 套件通过 `release:gate` 显式请求：

```bash
pnpm run release:gate -- --external ppe-repo
pnpm run release:gate -- --external ppe-npm-installed
pnpm run release:gate -- --external ppe-ops
pnpm run release:gate -- --external ppe-real-llm
```

推荐用法：

```bash
source scripts/release-gate-ppe-env.sh
pnpm run release:gate -- --external ppe-repo --external ppe-npm-installed --external ppe-ops --external ppe-real-llm
```

`scripts/release-gate-ppe-env.sh` 会导出 PPE 默认机器、目录、插件根目录、`traex` 路径，以及 4 个 `release:gate` external case 命令。

脚本入口：

- 默认入口是仓库内脚本：

```bash
node scripts/release-gate-ppe.mjs --case ppe-repo
node scripts/release-gate-ppe.mjs --case ppe-npm-installed
node scripts/release-gate-ppe.mjs --case ppe-ops
node scripts/release-gate-ppe.mjs --case ppe-real-llm
```

- `release:gate` 外部 case 仍可通过环境变量覆盖成任意命令。

手动覆盖示例：

```bash
export UA_RELEASE_GATE_EXTERNAL_PPE_REPO_CMD='node scripts/release-gate-ppe.mjs --case ppe-repo'
export UA_RELEASE_GATE_EXTERNAL_PPE_NPM_INSTALLED_CMD='node scripts/release-gate-ppe.mjs --case ppe-npm-installed'
export UA_RELEASE_GATE_EXTERNAL_PPE_OPS_CMD='node scripts/release-gate-ppe.mjs --case ppe-ops'
export UA_RELEASE_GATE_EXTERNAL_PPE_REAL_LLM_CMD='node scripts/release-gate-ppe.mjs --case ppe-real-llm'
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

可选环境变量：

- `UA_RELEASE_GATE_PPE_REPO_DIR`
- `UA_RELEASE_GATE_PPE_REPO_PROJECTS_ROOT`
- `UA_RELEASE_GATE_PPE_NPM_DIR`
- `UA_RELEASE_GATE_PPE_TRAEX_BIN`

`ppe-real-llm` 额外前置：

- PPE 机器已安装 `traex`
- `traex login --git-code` 可成功完成
- 脚本会临时写入一个 `llm` shim，把 `cli-spawn` provider 接到 `traex exec`
