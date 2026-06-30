# Deployment CLI Manual

部署所需要的所有命令、参数、YAML 字段在本文一站收口。原则：

1. **CLI 只暴露拓扑 / 救急开关**：host/port/project/profile/dry-run 这类一眼能看出"按场景调整"的字段。
2. **其他全部走 YAML / env**：LLM、record 接入、providers、retry 策略、worksheet 等 — 调一次 yaml 写到 `deploy.yaml`，从此不再翻 CLI。
3. **每台机器固定一份身份**：`~/.env` 写 `UA_DEPLOY_PROFILE=prod|ppe|dev`，CLI 只在临时换身份时显式覆盖。

> 完整测试矩阵收口在 [release-tests/README.md](./release-tests/README.md)；具体部署形态约束见 [release-tests/local/repo-checkout/expected-layout.md](./release-tests/local/repo-checkout/expected-layout.md)。

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

providers:
  llm:
    package: "<your-llm-provider-package>"
    config:
      model: "<your-model>"
      modelCandidates: ["small", "large"]
  auth:        { package: "...", config: {...} }
  orgPolicy:   { package: "...", config: {...} }
  portalAssets:{ package: "...", config: {...} }

record:
  providers: ["local"]       # "[]" 关闭所有外部 record
  config:
    feishu-sheets:
      spreadsheetToken: "{{ RECORD_SHEET_TOKEN }}"
      worksheets:
        nightly: "nightly-update"
        project: "project-update"

profiles:
  large:
    use: [llm]
    build:
      mode: "incremental"
      excludeTests: true
      llmAnalysis: true
      llmRequired: false
      llmRetry: { maxAttempts: 3, initialBackoffMs: 500, maxBackoffMs: 30000 }
  small:
    use: [llm]
    build:
      mode: "incremental"
      excludeTests: true
      llmAnalysis: true
      llmRetry: { maxAttempts: 2, initialBackoffMs: 300, maxBackoffMs: 10000 }
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
  --profile large
```

`UA_DEPLOY_PROFILE` 已在 `~/.env` 配好，不需要再传 `--deploy-profile`。

### 1.2 单项目临时跑一次（不影响其他项目）

```bash
scripts/daily-update.sh \
  --project mini-project \
  --profile small \
  --no-self-update
```

### 1.3 单项目调试（看 log）

```bash
scripts/nightly-project-sync.sh \
  --project mini-project \
  --profile small \
  --no-pull
```

```bash
tail -F $UA_PROJECTS_ROOT/projects/mini-project/.understand-anything/nightly-runs/*/build.log
```

### 1.4 救急：跳 self-update 或 git pull

```bash
scripts/daily-update.sh --profile large --no-self-update --no-pull
```

### 1.5 救急：手动重挂 shared gateway（不跑 build）

```bash
scripts/refresh-prod-server.sh \
  --host 0.0.0.0 --port 18666 \
  --profile large
```

### 1.6 救急：单项目重建 dashboard-dist 后再挂

```bash
understand-anyway dashboard build-dist \
  --project mini-project \
  --plugin-root $UA_PLUGIN_ROOT \
  --rebuild-dashboard

scripts/refresh-prod-server.sh --profile large
```

### 1.7 新机首次 bootstrap

```bash
echo 'UA_DEPLOY_PROFILE=ppe' >> ~/.env
echo 'UA_PROJECTS_ROOT=...'   >> ~/.env
echo 'UA_PLUGIN_ROOT=...'     >> ~/.env

scripts/daily-update.sh --profile small --no-pull
```

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

---

## 2. 脚本参数表

### 2.1 `scripts/daily-update.sh`

| 参数 | 默认 | 何时用 | YAML 兜底 |
|------|------|--------|-----------|
| `--host <addr>` | `127.0.0.1` | 改绑定地址 | `deploy.host` |
| `--port <num>` | `18666` | 改端口 | `deploy.port` |
| `--project <id>` | 全部 | 调试单项目 | — |
| `--profile <name>` | 不指定 | 选 yaml profile | — |
| `--deploy-profile <p>` | `$UA_DEPLOY_PROFILE` | 临时换身份；值 `prod\|ppe\|dev` | `~/.env` |
| `--plugin-root <path>` | `$UA_PLUGIN_ROOT` | 临时切上游版本 | env |
| `--no-self-update` | 关 | 救急跳 self-update | — |
| `--no-pull` | 关 | 救急跳项目 git pull | — |
| `--dry-run` | 关 | 调试 | — |

### 2.2 `scripts/nightly-project-sync.sh`

| 参数 | 默认 | 何时用 |
|------|------|--------|
| `--project <id>` | 全部 | 调试单项目 |
| `--profile <name>` | 不指定 | 选 yaml profile |
| `--no-pull` | 关 | 救急跳 git pull |
| `--dry-run` | 关 | 调试 |

### 2.3 `scripts/refresh-prod-server.sh`

| 参数 | 默认 | 何时用 |
|------|------|--------|
| `--host <addr>` | `127.0.0.1` | 改绑定 |
| `--port <num>` | `18666` | 改端口 |
| `--project <id>` | 全部 | 单项目刷新 |
| `--deploy-profile <p>` | `$UA_DEPLOY_PROFILE` | 临时换身份；拒绝 `dev` |
| `--profile <name>` | 不指定 | 选 yaml profile（forwarded as `--serve-profile`） |
| `--plugin-root <path>` | env | 当 dashboard-dist 不存在时需要 |
| `--dry-run` | 关 | 调试 |

> 没有 `--rebuild-all` / `--rebuild-project` / `--all-builds`。要重建单项目的 dashboard-dist 直接用 `understand-anyway dashboard build-dist`。

---

## 3. CLI 子命令速查

### 3.1 高频
```bash
understand-anyway init <repo> [--project <id>] [--repo-path <tmpl>] [--icon-file <path>]
understand-anyway build --project <id> [--plugin-root <dir>] [--profile <name>] [--incremental]
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
| `--profile <n>` | 选 `profiles.<n>` | 同义 `--serve-profile` 用于 `dashboard start` |
| `--deploy-profile` | `~/.env UA_DEPLOY_PROFILE` | env 必配，CLI 临时覆盖 |
| `--plugin-root` | `~/.env UA_PLUGIN_ROOT` | env 兜底，CLI 临时覆盖 |
| `--output-language` | `deploy.outputLanguage` / `profiles.<n>.build.outputLanguage` | CLI 临时覆盖 |

**完全 yaml-only** 字段（不在任何 sh 脚本暴露）：
- `gateway.retain`
- `providers.{auth,orgPolicy,portalAssets,llm,embedding}.{package,config}`
- `record.providers / record.config.<provider>.*`
- `profiles.<n>.build.{mode,excludeTests,outputLanguage,llmAnalysis,llmRequired,llmRetry.*}`
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
- **不允许 deprecated alias**：旧的 `--feishu-sheet` / `--llm-profile` / `--all-builds` / `--restart-gateway` / `--print-deploy-context` 全部移除。
- **不允许 LLM/record 走 CLI**：所有 LLM provider、retry policy、record sink 配置只接受 yaml。
- **不允许 incremental build 之外的 mode 通过 sh 脚本指定**：nightly 默认 `--incremental --exclude-tests`。要全量请直接 `understand-anyway build` 单独跑。
- **救急路径优先用 CLI 子命令**：例如重建单项目 dashboard-dist 应该用 `understand-anyway dashboard build-dist`，而不是给编排脚本加 `--rebuild` 开关。
