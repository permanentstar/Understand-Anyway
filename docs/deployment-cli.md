# Deployment CLI Manual

部署所需要的所有命令、参数、YAML 字段在本文一站收口。原则：

1. **CLI 只暴露拓扑 / 救急开关**：host/port/project/deploy-profile/llm-profile/dry-run 这类一眼能看出"按场景调整"的字段。
2. **其他全部走 YAML / env**：LLM、record 接入、providers、retry 策略、worksheet 等 — 调一次 yaml 写到 `deploy.yaml`，从此不再翻 CLI。
3. **每台机器固定一份身份**：`~/.env` 写 `UA_DEPLOY_PROFILE=prod|ppe|dev`，CLI 只在临时换身份时显式覆盖。

> 发版前统一门禁入口为 `pnpm run release:gate`。完整测试矩阵收口在 [release-tests/README.md](./release-tests/README.md)；具体部署形态约束见 [release-tests/local/repo-checkout/expected-layout.md](./release-tests/local/repo-checkout/expected-layout.md)。

> **两种运行形态**：源码 checkout 形态直接跑 `scripts/*.sh`；标准 OSS 安装形态（仅 `npm install @understand-anyway/cli`、无源码树）则通过 `understand-anyway ops <name>` 调用包内 `dist-scripts/` 里的同名编排脚本。详见 [§1.11](#111-标准-oss-安装形态无源码树)。

---

## 0. 配置先行：deploy.yaml 模板

完整字段示例见 [packages/cli/deploy.example.yaml](../packages/cli/deploy.example.yaml)。

关键骨架：

```yaml
version: 1

deploy:
  host: "0.0.0.0"            # CLI --host 可覆盖
  port: 18666                # CLI --port 可覆盖
  outputLanguage: "en"

gateway:
  retain: 3                  # gateway publish 时保留多少非保护 release
  # portalAssetsSubdir: "overlay"  # 可选；从 gateway/portal-assets/<subdir>/ 读取品牌资源

llmProfiles:
  traex:
    package: "<your-trae-cli-v2-provider-package>"
    config:
      command: "traex"
      model: "<your-model>"
      modelArg: "-m"
  traecli:
    package: "<your-trae-cli-v1-provider-package>"
    config:
      command: "traecli"
      model: "<your-model>"

providers:
  auth:        { package: "...", config: {...} }
  orgPolicy:   { package: "...", config: {...} }
  portalAssets:{ package: "...", config: {...} }

record:
  providers: ["local"]       # 加 "feishu-sheets" 可同步到在线表格；"[]" 关闭所有外部 record
  config:
    feishu-sheets:
      spreadsheetToken: "{{ RECORD_SHEET_TOKEN }}"
      # 三张标准表的 header 内置在 provider-feishu-sheets：
      # user-event / nightly-update / project-update
      # 不配置 worksheets 时，worksheet 名默认就是上述三个 key。
      # worksheets:
      #   user-event: "user-event"
      #   nightly-update: "nightly-update"
      #   project-update: "project-update"

deployProfiles:
  ppe:
    build:
      mode: "full"
      excludeTests: true
      llmAnalysis: true
      llmRequired: false
      mappers: 1
      llmConcurrencyPerMapper: 1
      llmQpmLimit: 2
      llmRetry: { maxAttempts: 2, initialBackoffMs: 300, maxBackoffMs: 10000 }
  prod:
    build:
      mode: "incremental"
      excludeTests: true
      llmAnalysis: true
      llmRequired: true
      mappers: 4
      llmConcurrencyPerMapper: 4
      llmQpmLimit: 30
      llmRetry: { maxAttempts: 3, initialBackoffMs: 500, maxBackoffMs: 30000 }

profiles:
  sso-portal:
    portal: true
    projectRoute: true
    use: [auth, orgPolicy, portalAssets]
    registry: "/path/to/understand-projects/gateway/registry.json"
```

环境变量（写在 `~/.env`，**不要进 yaml**）：

| 变量 | 用途 |
|------|------|
| `UA_DEPLOY_PROFILE` | 当前机器拓扑：`prod` / `ppe` / `dev`。**必须配置**，无默认 |
| `UA_PROJECTS_ROOT` | 用户项目根目录，默认 `$HOME/understand-projects` |
| `UA_PLUGIN_ROOT` | upstream Understand-Anything plugin 路径 |
| `UA_CONFIG` | 显式指定 deploy.yaml 路径（可选） |
| `UA_MAINTENANCE_*` | 全局/项目维护模式开关 |

---

## 1. 高频场景速查

按场景找命令，不需要先认参数。

### 1.1 每天 cron 全自动跑

```bash
scripts/daily-update.sh \
  --host 0.0.0.0 --port 18666 \
  --deploy-profile prod --llm-profile traex
```

`UA_DEPLOY_PROFILE` 已在 `~/.env` 配好，不需要再传 `--deploy-profile`。

### 1.2 单项目临时跑一次（不影响其他项目）

```bash
scripts/daily-update.sh \
  --project mini-project \
  --deploy-profile ppe --llm-profile traex \
  --no-self-update
```

### 1.3 单项目调试（看 log）

```bash
scripts/nightly-project-sync.sh \
  --project mini-project \
  --deploy-profile ppe --llm-profile traex \
  --no-pull
```

```bash
tail -F $UA_PROJECTS_ROOT/projects/mini-project/.understand-anything/nightly-runs/*/build.log
```

### 1.4 救急：跳 self-update 或 git pull

```bash
scripts/daily-update.sh --deploy-profile prod --llm-profile traex --no-self-update --no-pull
```

### 1.5 救急：手动重挂 shared gateway（不跑 build）

```bash
scripts/refresh-prod-server.sh \
  --host 0.0.0.0 --port 18666 \
  --deploy-profile prod
```

### 1.6 救急：单项目重建 dashboard-dist 后再挂

```bash
understand-anyway dashboard build-dist \
  --project mini-project \
  --plugin-root $UA_PLUGIN_ROOT \
  --rebuild-dashboard

scripts/refresh-prod-server.sh --deploy-profile prod
```

### 1.7 新机首次 bootstrap

```bash
echo 'UA_DEPLOY_PROFILE=ppe' >> ~/.env
echo 'UA_PROJECTS_ROOT=...'   >> ~/.env
echo 'UA_PLUGIN_ROOT=...'     >> ~/.env

scripts/daily-update.sh --deploy-profile ppe --llm-profile traex --no-pull
```

首次 clean state 不需要先手工跑一次 full build：`nightly-project-sync.sh`
会在 state root 还没有 `knowledge-graph.json` 时自动 bootstrap 一次 full
build，后续 nightly 再恢复到 `--incremental --exclude-tests`。

### 1.8 gateway runtime 操作

```bash
understand-anyway gateway publish --stable
understand-anyway gateway list --json
understand-anyway gateway rollback
understand-anyway gateway set-stable <versionId>
understand-anyway gateway gc --retain 3
```

### 1.9 项目版本操作

```bash
understand-anyway project-state publish <vid> \
  --project mini-project \
  --source-root $UA_PROJECTS_ROOT/src/mini-project \
  --stable

understand-anyway project-state list --project mini-project
understand-anyway project-state set-stable <vid> --project mini-project
understand-anyway project-state gc --project mini-project --retain 3
```

### 1.10 LLM 修复

```bash
understand-anyway repair llm-failures       --project <id>
understand-anyway repair llm-graph-failures --project <id>
```

### 1.10.1 大项目 LLM 中断后续跑

`--resume` 会复用已有 `scan-result.json / batches.json / batch-*.json`，
只补缺失 batch，并重新读取当前 deploy profile 的并发参数：

```bash
understand-anyway build \
  --project <id> \
  --resume \
  --deploy-profile prod \
  --llm-profile traex \
  --exclude-tests \
  --no-dashboard
```

### 1.11 标准 OSS 安装形态（无源码树）

只从 registry 安装 CLI、不 clone 源码时，用 `understand-anyway ops <name>` 调用包内
`dist-scripts/` 里的编排脚本，等价于源码形态下的 `scripts/<name>.sh`：

```bash
mkdir understand-anyway-ops
cd understand-anyway-ops
npm init -y
npm install @understand-anyway/cli          # 或 pnpm add / yarn add
npx understand-anyway ops daily-update          --project <id> --deploy-profile ppe --llm-profile traex
npx understand-anyway ops nightly-project-sync  --project <id> --deploy-profile ppe --llm-profile traex
npx understand-anyway ops refresh-prod-server   --deploy-profile ppe
```

- 可用脚本：`daily-update`、`nightly-project-sync`、`refresh-prod-server`。参数与
  对应 `scripts/<name>.sh` 完全一致（见 [§2 脚本参数表](#2-脚本参数表)），`ops`
  之后的所有参数原样透传。
- 如果用 `npm install -g @understand-anyway/cli` 做全局安装，可以把上面的
  `npx understand-anyway` 简写为 `understand-anyway`。
- 包内脚本以 `bash <script>` 方式互相调用，不依赖文件 exec 位（npm 安装会丢 exec 位）。
- gateway runtime release 在 npm 扁平 `node_modules` 布局下会连同依赖一起复制，
  无需源码 workspace。

---

## 2. 脚本参数表

### 2.1 `scripts/daily-update.sh`

| 参数 | 默认 | 何时用 | YAML 兜底 |
|------|------|--------|-----------|
| `--host <addr>` | `127.0.0.1` | 改绑定地址 | `deploy.host` |
| `--port <num>` | `18666` | 改端口 | `deploy.port` |
| `--project <id>` | 全部 | 调试单项目 | — |
| `--deploy-profile <p>` | `$UA_DEPLOY_PROFILE` | 临时换身份；值 `prod\|ppe\|dev` | `~/.env` |
| `--llm-profile <name>` | 不指定 | 选 `llmProfiles.<name>` | — |
| `--plugin-root <path>` | `$UA_PLUGIN_ROOT` | 临时切上游版本 | env |
| `--no-self-update` | 关 | 救急跳 self-update | — |
| `--no-pull` | 关 | 救急跳项目 git pull | — |
| `--dry-run` | 关 | 调试 | — |

### 2.2 `scripts/nightly-project-sync.sh`

| 参数 | 默认 | 何时用 |
|------|------|--------|
| `--project <id>` | 全部 | 调试单项目 |
| `--deploy-profile <p>` | 不指定 | 选 `deployProfiles.<p>.build` |
| `--llm-profile <name>` | 不指定 | 选 `llmProfiles.<name>` |
| `--no-pull` | 关 | 救急跳 git pull |
| `--dry-run` | 关 | 调试 |

### 2.3 `scripts/refresh-prod-server.sh`

| 参数 | 默认 | 何时用 |
|------|------|--------|
| `--host <addr>` | `127.0.0.1` | 改绑定 |
| `--port <num>` | `18666` | 改端口 |
| `--project <id>` | 全部 | 单项目刷新 |
| `--deploy-profile <p>` | `$UA_DEPLOY_PROFILE` | 临时换身份；拒绝 `dev` |
| `--plugin-root <path>` | env | 当 dashboard-dist 不存在时需要 |
| `--dry-run` | 关 | 调试 |

> 没有 `--rebuild-all` / `--rebuild-project` / `--all-builds`。要重建单项目的 dashboard-dist 直接用 `understand-anyway dashboard build-dist`。

---

## 3. CLI 子命令速查

### 3.1 高频
```bash
understand-anyway init <repo> [--project <id>] [--repo-path <tmpl>] [--icon-file <path>]
understand-anyway build --project <id> [--plugin-root <dir>] [--deploy-profile <p>] [--llm-profile <name>] [--incremental]
understand-anyway dashboard build-dist --project <id> --plugin-root <dir> [--rebuild-dashboard]
understand-anyway dashboard start --project <id> --host <h> --port <p> [--no-open]
understand-anyway dashboard stop --project <id>
understand-anyway project-state publish <vid> --project <id> --source-root <dir> [--stable] [--retain <n>]
understand-anyway gateway publish        [--stable] [--retain <n>] [--plugin-root <dir>]
```

### 3.2 中频
```bash
understand-anyway gateway rollback / set-stable / list / gc
understand-anyway project-state set-stable / list / gc
understand-anyway compat                 [--update --json]
understand-anyway review-graph-health    --project <id> --output <file>
understand-anyway notify nightly         --report <file> [--best-effort]
understand-anyway repair llm-failures / llm-graph-failures --project <id>
```

### 3.3 救急
```bash
understand-anyway gateway stop           --projects-root <dir>
understand-anyway gateway start          --projects-root <dir> --host <h> --port <p> --no-open
understand-anyway dashboard status       [--project <id> | --projects-root <dir>]
understand-anyway serve --project <id>   # 前台 serve，不走 daemon
```

---

## 4. YAML ↔ CLI 字段对照（仅列保留的 CLI 项）

| CLI 参数 | YAML 字段 | 备注 |
|----------|-----------|------|
| `--host` / `--port` | `deploy.host` / `deploy.port` | CLI 临时覆盖 |
| `--deploy-profile <p>` | `deployProfiles.<p>.build` | 选择构建模式、可靠性和并发预算 |
| `--llm-profile <n>` | `llmProfiles.<n>` | 选择 traex / traecli 等 LLM provider |
| `UA_DEPLOY_PROFILE` | `~/.env UA_DEPLOY_PROFILE` | env 必配，CLI 可用 `--deploy-profile` 临时覆盖 |
| `--plugin-root` | `~/.env UA_PLUGIN_ROOT` | env 兜底，CLI 临时覆盖 |
| `--output-language` | `deploy.outputLanguage` / `deployProfiles.<n>.build.outputLanguage` | CLI 临时覆盖 |

**完全 yaml-only** 字段（不在任何 sh 脚本暴露）：
- `gateway.retain`
- `providers.{auth,orgPolicy,portalAssets,embedding}.{package,config}`
- `llmProfiles.<n>.{package,config}`
- `record.providers / record.config.<provider>.*`
- `deployProfiles.<n>.build.{mode,excludeTests,outputLanguage,llmAnalysis,llmRequired,mappers,llmConcurrencyPerMapper,llmQpmLimit,llmRetry.*}`
- `profiles.<n>.{portal,projectRoute,registry,use}`

---

## 5. 错误码与常见提示

| 退出码 | 含义 | 触发场景 |
|--------|------|----------|
| 0 | 成功 | 全部步骤成功，或 daily 在 best-effort 阶段失败但 nightly+refresh 都过 |
| 1 | 业务失败 | 任一项目 build 或 gate 拒绝；refresh 出现 failed_count > 0 |
| 2 | 参数错误 | `--deploy-profile` 不在 `prod\|ppe\|dev`、必填值缺失、refresh 收到 `dev` |
| 127 | 命令找不到 | `understand-anyway` 不在 PATH 且 `packages/cli/dist/cli.js` 不存在 |

常见 stderr 模式：
- `deploy profile not configured: set UA_DEPLOY_PROFILE in ~/.env or pass --deploy-profile`
- `invalid deploy profile: <x> (expected prod|ppe|dev)`
- `[refresh-prod-server] dev deploy profile is not allowed for prod refresh`
- `[refresh-prod-server] missing --plugin-root and <state-dir>/dashboard-dist is absent`
- `[nightly-project-sync] project=<x> publish failed; nightly will surface the build but prod refresh may serve stale dist`

---

## 6. 设计原则备忘

- **不允许 auto-detect**：deploy profile 必须显式声明（CLI 或 env），SSH-based heuristics 已废弃。
- **不允许 deprecated alias**：旧的 `--profile`（脚本 build 规格）/ `--feishu-sheet` / `--all-builds` / `--restart-gateway` / `--print-deploy-context` 全部移除。
- **不允许 LLM/record 走 CLI**：所有 LLM provider、retry policy、record sink 配置只接受 yaml。
- **不允许通过 sh 脚本暴露 full/resume mode 开关**：nightly 默认走
  `--incremental --exclude-tests`；若 state root 尚无 graph（如新机首次
  bootstrap），脚本内部会自动先跑一次 full build。要强制全量，仍应直接
  `understand-anyway build` 单独跑。
- **救急路径优先用 CLI 子命令**：例如重建单项目 dashboard-dist 应该用 `understand-anyway dashboard build-dist`，而不是给编排脚本加 `--rebuild` 开关。
