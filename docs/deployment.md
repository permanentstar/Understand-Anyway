# Understand-Anyway 部署架构

本文讲**为什么**和**总体结构**。

| 想找 | 看哪里 |
|------|--------|
| 日常命令、参数、deploy.yaml 字段速查 | [deployment-cli.md](./deployment-cli.md) |
| 验证一次完整部署（local） | [release-tests/README.md](./release-tests/README.md) |
| 本地模拟 npm 发布 | [local-release-verification.md](./local-release-verification.md) |
| 升级/兼容 upstream Understand-Anything plugin | `understand-anyway compat --plugin-root <dir> --update` |

读者：
- **部署/接入用户**：理解架构后跳 [deployment-cli.md](./deployment-cli.md) 直接抄命令。
- **OSS 维护者**：新增命令 / profile / 部署能力时，回到第 3、4 节判断分层。

## 1. 前置要求

- Node.js 20+，pnpm 9+
- upstream Understand-Anything plugin 独立安装（Understand-Anyway 不捆绑）
- 每个被分析项目是本机可读的 git checkout
- LLM / 鉴权 / 组织策略 / 通知 / 品牌资源走 YAML provider 包名动态加载；开源代码不内置任何私有 provider

最小安装：

```bash
pnpm install && pnpm build
```

## 2. 运行态总览

```
+------------------+    +-------------------+    +--------------------+
| daily-update.sh  | -> | nightly-project-* | -> |  refresh-prod-*    |
+------------------+    +-------------------+    +--------------------+
        |                       |                          |
        v                       v                          v
   gateway publish      build + publish               registry + shared
   (versioned release)  (per-project version)         gateway remount
```

落盘形态（标准版本化布局，由 `project-state publish` 与 `gateway publish` 维护）：

```
$UA_PROJECTS_ROOT/
├── gateway/
│   ├── config/{projects.json,deploy.yaml}
│   ├── registry.json
│   ├── portal-assets/
│   ├── operations/{nightly,daily}-runs/
│   └── runtime/{current,stable}  → releases/<vid>/
└── projects/<project>/
    ├── versioned-state.json
    ├── current  → versions/<vid>/
    ├── stable   → versions/<vid>/
    └── versions/<vid>/{.understand-anything,dashboard-dist}
```

**禁止扁平绕过**：所有部署用例必须经过 `project-state publish` 落入 `versions/<vid>/`。详见 [release-tests/local/repo-checkout/expected-layout.md](./release-tests/local/repo-checkout/expected-layout.md)。

旧布局不会自动迁移：如果仍存在 `$UA_PROJECTS_ROOT/config/projects.json`，CLI / scripts 会提示迁到 `$UA_PROJECTS_ROOT/gateway/config/projects.json`，项目状态请重新 `init/build/publish` 或手动搬到 `projects/<projectId>/` 后再验证。

## 3. 配置分层与优先级

deploy.yaml 是真相源（参见 [packages/cli/deploy.example.yaml](../packages/cli/deploy.example.yaml) 和 [deployment-cli.md §0](./deployment-cli.md)）。

优先级（高 → 低）：

| 层级 | 来源 | 覆盖动机 |
|------|------|----------|
| 1 | CLI flag | 一次性临时覆盖 |
| 2 | 受支持的 `UA_*` env | 机器固定值（如 `UA_DEPLOY_PROFILE` / `UA_PLUGIN_ROOT` / `UA_PROJECTS_ROOT` / `UA_CONFIG`） |
| 3 | YAML `profiles.<name>` | 选定的运行模板 |
| 4 | YAML 顶层（`deploy.*` / `gateway.*` / `record.*` / `providers.*`） | 全局基础值 |
| 5 | 代码默认 | 兜底 |

env 层不是通配层；只有显式列出的 `UA_*` 才参与覆盖。具体名单见 [deployment-cli.md §0](./deployment-cli.md)。

配置 discovery（依次）：

1. `--config <file|dir>`
2. `UA_CONFIG=<file|dir>`
3. `./deploy.yaml` 或 `./config/deploy.yaml`
4. 可执行包根目录下的 `deploy.yaml` 或 `config/deploy.yaml`

**Secret 注入只允许占位符**：

```yaml
providers:
  llm:
    config:
      token: "{{ LLM_TOKEN }}"            # 来自 shell env 或 .env 链
      caBundle: "{{ file('/run/secrets/ca.pem') }}"   # 文件内容 trim
```

secret value 不写入 `deploy.yaml`。

## 4. CLI 命令形态分层

Understand-Anyway 同时保留 flat 命令和动词族子命令。

**Flat 命令**（一次运行做一个稳定动作，参数主要描述输入输出）：

- `build` 对一个 repo 产出/更新 graph state
- `serve --project <id>` 读取已注册项目并启动只读 gateway
- `compat` 探测 upstream contract drift
- `batch-mapper-worker` 内部 worker，非稳定公共入口

**动词族子命令**（同一资源有多个生命周期动作）：

- `dashboard <start|build-dist|stop|stop-all|status>`
- `gateway <publish|set-stable|rollback|list|gc>`
- `project-state <publish|set-stable|list|gc>`
- `notify nightly`
- `repair <llm-failures|llm-graph-failures>`

**判定规则**：

- 一次稳定动作 + 输入输出参数 → flat
- 同资源多生命周期动作 → 动词族
- 只服务内部调度、不承诺兼容性 → 内部命令（隐藏）
- 新增动作改变已有资源状态 → 放入已有动词族，**不要用 profile 伪装成动作**

## 5. profile 与 args 不变量

1. **维度正交**：profile 描述环境/运行模板；args 描述本次调用动作和目标。
2. **普适性**：profile 必须能多次复用，不能只表达一次性任务。
3. **优先级**：显式 CLI flag 永远高于 env、profile、deploy 默认值。
4. **profile 不表达动作**：动作必须由命令或子命令表达，profile 只补参数。

正反例：

| 场景 | 推荐 | 不推荐 | 原因 |
|------|------|--------|------|
| nightly 构建模板 | `build --profile nightly` | `build --nightly` | nightly 是参数组合，不是新动作 |
| 临时降并发 | `build --profile nightly --mapper-concurrency 1` | 新增 `debug-low-concurrency` profile | 一次性 override 应放 CLI flag |
| rollback | `gateway rollback` | `--profile rollback` | rollback 是动作，必须是子命令 |
| 开 portal + 鉴权 | `serve --serve-profile sso-portal` | 新 flat 命令 `serve-sso` | 这是 serve 参数组合 |
| 受控 LLM 修复 | `repair llm-failures --project <id>` | `build --profile repair-llm` | 修复不是 build 模板 |

## 6. 调度脚本三件套

三件套都是**编排器**，本身不带 LLM / record / provider 配置开关，只透传 CLI 拓扑参数（host/port/project/profile/plugin-root/dry-run）。所有业务配置走 deploy.yaml。具体参数表见 [deployment-cli.md §2](./deployment-cli.md)。

```
daily-update.sh
  ├─ self-update (git pull + pnpm install + pnpm build)
  ├─ gateway publish gate (best-effort)
  ├─ nightly-project-sync.sh
  │    ├─ per-project: git pull → build → project-state publish → graph-health gate
  │    └─ gateway/operations/nightly-latest.json + 项目级 nightly-latest.json
  ├─ notify nightly (best-effort)
  ├─ refresh-prod-server.sh
  │    └─ 项目通过门禁 → dashboard build-dist → registry upsert → 共享 gateway 重挂
  └─ aggregate-daily.mjs
```

**关键约束**：

- 共享 gateway 永远是 stop-before-start，每次 refresh 都重挂
- 项目门禁条件：`nightly-latest.json.overallStatus === "success"`；没通过的项目不刷新（必须先跑通 nightly）
- 救急路径用 CLI 子命令直跑（如 `understand-anyway dashboard build-dist`），不要给编排脚本加 `--rebuild` 类开关

## 7. Gateway 版本化

Gateway release 不可变。运行态通过两个指针管理：

- `current`：当前对外运行版本
- `stable`：人工确认可回滚版本

GC 必须保护 current + stable；rollback 只翻转指针，不重建 release。

具体命令在 [deployment-cli.md §1.8 / §3](./deployment-cli.md)。

## 8. Nightly Gating

nightly 强制走 `understand-anyway review-graph-health` 默认 gate（确定性 graph-health 检查）。CLI 不暴露外部 review hook —— 想接入外部 review 请实现一个 wrapper 命令并替换 `review-graph-health` 调用，或者把 review 逻辑落到 yaml 后续扩展点（暂未提供）。

review 输出契约：

```json
{"approved": true, "issues": [], "warnings": [], "stats": {}}
```

详细字段 + nightly result.json schema 见各项目 `nightly-runs/<run-id>/result.json`。

## 9. Notify

开源默认走 [LocalFileNotifyProvider](../packages/cli/src/notify)，写入：

```text
<projectsRoot>/notifications/<run-id>.json
```

外部 IM / 告警系统必须通过 overlay provider 接入：

```bash
understand-anyway notify nightly \
  --report ~/understand-projects/gateway/operations/nightly-latest.json \
  --notify-provider "<your-notify-provider-package>"
```

provider 包名只在 `deploy.yaml` `providers.notify.package` 里声明，或者上面 CLI 一次性指定。第三方包需在部署机另外 `npm install`，CLI 通过动态 import 加载。

## 10. Repair

repair 是**人工触发的受控路径**，永远不属于 nightly 主链路：

- `repair llm-failures`：读最近一次 LLM stats，重跑失败文件，patch batch artifact，merge 持久化
- `repair llm-graph-failures`：扫 graph-level enrichment gap，写 deferred report（不直接改 graph）

报告写入：

```text
<state-dir>/.understand-anything/repair-runs/<run-id>/result.json
```

命令见 [deployment-cli.md §1.10](./deployment-cli.md)。

## 11. 维护者新增能力流程

| 需求 | 落点 |
|------|------|
| 新增一次性动作（改资源状态） | 已有动词族的子命令 |
| 新增可复用环境模板 | `deploy.yaml profiles.<name>` |
| 新增本次调用的一次性参数 | flat 命令的 CLI flag |
| 新增机器固定身份 / 默认值 | `UA_*` env（在 `~/.env`），并在 schema 显式声明 |
| 新增外部系统接入 | provider 包名 + `deploy.yaml providers.*`，不入开源代码 |

新增前必须能用第 4、5 节的判定规则给出明确归属；否则停一停，先讨论。
