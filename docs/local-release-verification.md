# 本地发布验证指南

本文用于在不发布到公开 npm registry、不配置 GitHub `NPM_TOKEN` 的前提下，验证大部分发布后安装和 CLI 使用流程。

执行顺序：

1. **先完成 repo 部署验证**：直接基于当前 checkout 运行 `pnpm install && pnpm build`、调度脚本、gateway、overlay 注入等流程，确认代码版本本身可部署。
2. **代码版本固化后再做本地 npm 发布验证**：用 Verdaccio 本地 registry 模拟社区用户从 npm 安装 `@understand-anyway/cli` 的路径。

本文件只覆盖第 2 步。第 1 步仍按 [部署指南](./deployment.md) 的 repo 部署流程执行。

适用场景：

- release 前确认包内容、bin、包间依赖和 `workspace:*` 替换是否正确。
- 改动 CLI、package metadata、`files` 白名单、provider API 或 release 配置后做本地回归。
- 验证社区用户“不 clone 仓库，直接安装 npm 包后使用 CLI”的体验。

不覆盖的内容：

- `scripts/release.mjs` 在真实 npm registry 上跑（本手册只覆盖 dry-run / Verdaccio 演练）。
- GitHub secret `NPM_TOKEN` 权限。
- npm 公开 registry 上 `@understand-anyway/*` scope 权限。
- 公开包名是否已被占用。
- 真实 tag / npm publish 的线上链路。

推荐结论：本地 registry 验证可覆盖约 90% 的安装使用链路；公开 npm 真发仍需要最后单独验证。

## 1. 前置条件

本机需要：

- Node.js 20+。
- pnpm 9+。
- 本仓库已安装依赖。
- upstream Understand-Anything plugin 已安装到一个可解析的 plugin root。

先在仓库根目录构建一次：

```bash
pnpm install
pnpm build
```

## 2. 确认 upstream plugin root

Understand-Anyway 不捆绑 upstream。CLI 会按以下顺序定位 upstream plugin root：

1. CLI `--plugin-root <dir>`。
2. 环境变量 `UA_PLUGIN_ROOT`。
3. `~/.understand-anything-plugin`。
4. `~/.understand-anything/repo/understand-anything-plugin`。

推荐本地验证时显式设置 `UA_PLUGIN_ROOT`，避免不同机器路径差异：

```bash
export UA_PLUGIN_ROOT="/path/to/understand-anything-plugin"
```

该目录必须满足这些条件：

```bash
test -f "$UA_PLUGIN_ROOT/package.json"
test -f "$UA_PLUGIN_ROOT/skills/understand/scan-project.mjs"
test -f "$UA_PLUGIN_ROOT/skills/understand/compute-batches.mjs"
test -f "$UA_PLUGIN_ROOT/skills/understand/merge-batch-graphs.py"
node -e 'const { createRequire } = require("node:module"); const r = createRequire(process.env.UA_PLUGIN_ROOT + "/package.json"); console.log(r.resolve("@understand-anything/core"));'
```

预期：所有 `test` 命令退出码为 0，最后一行打印 `@understand-anything/core` 的解析路径。

如果上面的检查失败，先修 upstream 安装，不要继续验证 Understand-Anyway 包发布流程。否则后续 build/dashboard 失败无法区分是包问题还是 upstream 路径问题。

## 3. npm 本地 registry 验证

Verdaccio 能模拟 npm registry，最接近真实发布。为避免版本冲突，每次验证都用临时 storage。

### 3.1 启动临时 registry

新开一个终端：

```bash
REGISTRY_ROOT="$(mktemp -d)"
cat > "$REGISTRY_ROOT/config.yaml" <<YAML
storage: "$REGISTRY_ROOT/storage"
auth:
  htpasswd:
    file: "$REGISTRY_ROOT/htpasswd"
uplinks:
  npmjs:
    url: https://registry.npmjs.org/
packages:
  '@understand-anyway/*':
    access: \$all
    publish: \$all
  '**':
    access: \$all
    publish: \$all
    proxy: npmjs
log: { type: stdout, format: pretty, level: warn }
YAML

pnpm dlx verdaccio -c "$REGISTRY_ROOT/config.yaml" -l 127.0.0.1:4873
```

说明：

- 只监听 `127.0.0.1`。
- `publish: $all` 只用于本机临时验证，不能复用到共享环境。
- 每次 `mktemp -d` 都是全新 registry，避免重复版本 publish 失败。

### 3.2 发布到本地 registry

回到仓库根目录：

```bash
LOCAL_REGISTRY="http://127.0.0.1:4873"

node scripts/release.mjs patch --skip-git --registry "$LOCAL_REGISTRY"
```

预期：

- release script 按真实发布链路执行版本改写、`pnpm install --lockfile-only`、
  `pnpm -r build`、逐包 `pnpm publish packages/<pkg-dir> --dry-run`，然后按依赖顺序发布到本地 registry。
- 根包 `understand-anyway` 因 `private: true` 不发布。
- 所有公开 workspace 包发布到本地 registry。
- 包内 `workspace:*` 依赖在 publish 阶段被替换为本次演练的目标版本号。
- 因为这是 `--skip-git` 演练，不会 commit/tag/push；命令会留下
  `packages/*/package.json` 和 `pnpm-lock.yaml` 的版本变更。验证结束后如不保留
  该版本，请恢复这些文件。

如果要只做 release script plan 预览，不写入本地 registry：

```bash
node scripts/release.mjs patch --dry-run --skip-git --registry "$LOCAL_REGISTRY"
```

这个 dry-run 只打印 release 计划，不执行版本改写、build、pack dry-run 或
publish；它不能验证“从 registry 安装”的行为。

### 3.3 在干净目录安装 CLI

```bash
VERIFY_ROOT="$(mktemp -d)"
cd "$VERIFY_ROOT"

printf '{"private":true,"type":"module"}\n' > package.json
pnpm add @understand-anyway/cli --registry "$LOCAL_REGISTRY"
pnpm exec understand-anyway --help
```

预期：

- `pnpm add` 能从本地 registry 拉到 CLI 及其内部依赖包。
- `pnpm exec understand-anyway --help` 能打印 CLI help。

### 3.4 验证 upstream contract

继续在干净目录中执行：

```bash
export UA_PLUGIN_ROOT="/path/to/understand-anything-plugin"
pnpm exec understand-anyway compat
```

预期：compat 命令能定位 upstream 并完成 contract 检查。

### 3.5 验证 build 命令

使用一个本机可读 repo。可以用本仓库 fixture：

```bash
SOURCE_REPO="/path/to/Understand-Anyway/packages/core/fixtures/sample-repo"
PROJECTS_ROOT="$VERIFY_ROOT/projects"
export UA_PROJECTS_ROOT="$PROJECTS_ROOT"

pnpm exec understand-anyway init "$SOURCE_REPO" --project sample-repo --repo-path "$SOURCE_REPO"
pnpm exec understand-anyway build \
  --project sample-repo \
  --plugin-root "$UA_PLUGIN_ROOT"

STATE_DIR="$PROJECTS_ROOT/projects/sample-repo"
test -f "$STATE_DIR/.understand-anything/knowledge-graph.json"
test -f "$STATE_DIR/.understand-anything/meta.json"
test -f "$STATE_DIR/.understand-anything/config.json"
```

预期：三个 state 文件存在，build 退出码为 0。

### 3.6 验证 dashboard-dist 和 gateway

这一步需要 upstream dashboard 的构建依赖可用：

```bash
pnpm exec understand-anyway dashboard build-dist \
  --project sample-repo \
  --plugin-root "$UA_PLUGIN_ROOT" \
  --rebuild-dashboard

test -f "$STATE_DIR/dashboard-dist/index.html"
```

启动一次本地 gateway：

```bash
pnpm exec understand-anyway dashboard start \
  --project sample-repo \
  --host 127.0.0.1 \
  --port 0 \
  --no-open
```

预期：命令输出一个本地 URL。访问该 URL 能打开 dashboard。验证结束后停止：

```bash
pnpm exec understand-anyway dashboard stop --project sample-repo
```

### 3.7 验证 gateway release 命令

本地安装的 CLI 也应能完成 runtime gateway release 打包：

```bash
PROJECTS_ROOT="$VERIFY_ROOT/projects"
mkdir -p "$PROJECTS_ROOT"

pnpm exec understand-anyway gateway publish \
  --projects-root "$PROJECTS_ROOT" \
  --plugin-root "$UA_PLUGIN_ROOT" \
  --stable \
  --retain 2

pnpm exec understand-anyway gateway list \
  --projects-root "$PROJECTS_ROOT"
```

预期：

- `<projectsRoot>/gateway/runtime/releases/<version>/dist/cli.js` 存在。
- `gateway list` 能看到 current/stable 指针。

## 4. 自动化脚本

发版前主入口已沉淀为：

```bash
pnpm run release:gate
```

它会强制执行本地必跑门禁；如本次发版明确要求外部环境，再显式追加：

```bash
source scripts/release-gate-ppe-env.sh
pnpm run release:gate -- --external ppe-repo --external ppe-npm-installed
```

原有一键本地交付脚本继续保留为门禁内部组件：

```bash
pnpm run delivery:local
```

脚本默认执行 repo-checkout、Verdaccio 发包安装、shared-gateway 三层验证；可用 `--only <case>` 只跑单层，用 `--profile real-llm` 把 shared-gateway 的 LLM 富化切到真实 CLI provider。

GitHub 回归策略：

- 主 CI 不依赖 Verdaccio 和 upstream plugin，继续只跑 `build/typecheck/test/test:scripts`。
- 本地 npm registry 验证可作为后续 `release-preflight` 手动 workflow，不应进入每次 PR 的主门禁。
- 如果 workflow 要覆盖 `build/dashboard` E2E，需要显式安装 upstream plugin 或提供缓存好的 plugin root。

## 5. 每次本地发布验证 checklist

**首选：跑统一门禁**

```bash
export UA_PLUGIN_ROOT="/path/to/understand-anything-plugin"
pnpm run release:gate
```

门禁退出码 0 即视为本地发版门禁通过；详见 [docs/release-tests/README.md](./release-tests/README.md)。

**手工 fallback：** 仅在 `pnpm run delivery:local` 失败、需要单步排查时使用：

```bash
pnpm build
pnpm typecheck
pnpm test
pnpm test:scripts
node scripts/release.mjs patch --dry-run --skip-git --registry http://127.0.0.1:4873  # plan only
pnpm -r publish --dry-run --no-git-checks  # package pack validation only
```

然后用 Verdaccio 跑：

```bash
node scripts/release.mjs patch --skip-git --registry http://127.0.0.1:4873
VERIFY_ROOT="$(mktemp -d)"
cd "$VERIFY_ROOT"
printf '{"private":true,"type":"module"}\n' > package.json
pnpm add @understand-anyway/cli --registry http://127.0.0.1:4873
pnpm exec understand-anyway --help
pnpm exec understand-anyway compat --plugin-root "$UA_PLUGIN_ROOT"
SOURCE_REPO="/path/to/Understand-Anyway/packages/core/fixtures/sample-repo"
pnpm exec understand-anyway init "$SOURCE_REPO" --project sample-repo --repo-path "$SOURCE_REPO"
pnpm exec understand-anyway build --project sample-repo --plugin-root "$UA_PLUGIN_ROOT"
```

完整 runtime 验证再加：

```bash
pnpm exec understand-anyway dashboard build-dist --project sample-repo --plugin-root "$UA_PLUGIN_ROOT" --rebuild-dashboard
pnpm exec understand-anyway dashboard start --project sample-repo --host 127.0.0.1 --port 0 --no-open
pnpm exec understand-anyway dashboard stop --project sample-repo
pnpm exec understand-anyway gateway publish --projects-root "$PROJECTS_ROOT" --plugin-root "$UA_PLUGIN_ROOT" --stable --retain 2
```

## 6. 与公开 npm 发布的关系

本地 registry 验证通过后，可以认为：

- 包内容正确。
- `bin` 可用。
- 包间依赖基本正确。
- `workspace:*` 发布替换链路可用。
- CLI 安装后能定位 upstream 并跑核心命令。

仍需公开发布前最后确认：

- npm 上 `@understand-anyway` scope 具有发布权限。
- `node scripts/release.mjs patch --dry-run` 在干净的 `main` 上能打印正确 release plan；真实前置检查在非 dry-run 发布或 Verdaccio 演练路径执行。
- `scripts/release.mjs` 在 Verdaccio 上以 `--skip-git --registry http://127.0.0.1:4873` 演练能顺利到发包成功；演练后还原所有 workspace `package.json` 与 `pnpm-lock.yaml` 的版本号改动。
- npm 包、git tag、GitHub Release notes（`v<version>`）与版本号一致。
