# 发版门禁设计

## 当前决定

- 采用方案 2
- 含义：
  - 每次 public release 前，本地门禁必须完整通过
  - 外部环境验证不是默认强制项，但一旦本次发版明确要求跑，就变成阻塞项
  - 例如今天这种“全跑”的场景，PPE 套件就是本次发版的必跑项

## 现状问题

仓库里已经有不少验证资产，但现在是散的：

- 静态检查散在根 `package.json` 里
- 本地部署验证收在 `scripts/local-delivery-tests.mjs`
- 发布/部署 runbook 收在 `docs/release-tests/`
- PPE 验证依赖操作者记忆和当天口头要求
- `set-stable`、`rollback`、`gc` 这类常用运维动作还没进入统一发版门禁

这会带来两个直接风险：

1. 发版前到底“必须跑哪些”不够明确，容易只跑一部分就误以为可以发
2. 环境相关问题发现得太晚，因为外部环境验证没有被建模成固定、可复跑的测试用例

## 目标

1. 明确一份唯一的发版前测试清单
2. 把本地发版门禁收成固定入口，且每次发版都必须跑
3. 把外部环境验证也收成正式套件，而不是临时 shell 手工活
4. 明确常规运维命令各自的覆盖方式，避免“感觉测过了”
5. 优先复用现有脚本和文档，不重写整套验证框架
6. 每次门禁运行都输出一份人类可读 summary 和一份机器可读 JSON 结果

## 非目标

1. 不把 PPE 或其他外部环境默认提升为每次 release 都必须跑
2. 第一阶段不把所有门禁强塞进 CI
3. 不借这个需求重做 release/build/deploy 架构
4. 第一阶段不追求对任意第三方环境的通用自动化适配

## 门禁策略

### 1. 本地门禁：始终必跑

每次 public release 前，操作者本机必须完整通过本地门禁。

本地必跑覆盖面：

1. 仓库静态检查
   - `pnpm -r typecheck`
   - `pnpm -r build`
   - `pnpm -r test`
   - `pnpm test:scripts`
   - `pnpm lint:isolation`
   - `pnpm lint:isolation:test`
   - `pnpm lint:scripts`
   - `git diff --check`
2. 发布链路 rehearsal
   - `node scripts/release.mjs patch --dry-run`
3. 本地构建模式矩阵
   - `understand-anyway build --project <id>` 全量
   - `understand-anyway build --project <id> --incremental`
   - `understand-anyway build --project <id> --resume`
   - `understand-anyway build --project <id> --backfill`
4. 本地部署矩阵
   - repo checkout 部署
   - Verdaccio + npm-installed CLI 部署
   - shared gateway 多项目流
   - 本地真实 LLM (`--profile real-llm`)
5. 本地运维/版本矩阵
   - `dashboard build-dist`
   - `dashboard start`
   - `dashboard stop`
   - `dashboard status`
   - `gateway start`
   - `gateway stop`
   - `gateway publish`
   - `gateway set-stable`
   - `gateway rollback`
   - `gateway list`
   - `gateway gc`
   - `project-state publish`
   - `project-state set-stable`
   - `project-state rollback`
   - `project-state list`
   - `project-state gc`
   - `compat`
   - `review-graph-health`
   - `notify nightly`
   - `serve --project`
   - `repair llm-failures`
   - `repair llm-graph-failures`
6. 编排脚本断言
   - clean state 首次 bootstrap
   - 无变更场景的幂等 rerun
   - nightly 成功后的 refresh 路径

### 2. 外部环境门禁：按需启用，但一旦启用就是阻塞项

外部环境套件默认不是每次 release 的硬门禁。只有在本次发版被明确要求时，才会进入阻塞范围。

典型外部套件：

- PPE repo-checkout 部署
- PPE npm-installed CLI 部署
- PPE ops/versioning
- PPE real coco / cli-spawn LLM

规则很简单：

- 不要求跑：记为 `not-run`
- 明确要求跑：必须通过，否则本次 release 失败

## 设计方案

整体思路是不推翻现有验证资产，而是在它们上面加一层统一编排。

### A. 增加统一入口

新增统一入口：

```bash
pnpm run release:gate
```

背后对应新脚本：

```bash
node scripts/release-gate.mjs
```

职责：

1. 按固定顺序执行本地必跑项
2. 尽量调用现有脚本，而不是把逻辑复制一遍
3. 按参数决定是否追加外部环境套件
4. 汇总出一份 summary 和一份 JSON 结果

### B. 继续复用 `local-delivery-tests`

`scripts/local-delivery-tests.mjs` 继续作为本地部署用例的拥有者，不再造第二套本地部署 runner。

它负责的本地用例应当继续包括：

- `repo-checkout`
- `verdaccio`
- `shared-gateway`
- 新增 `ops-versioning`
- 视实现拆分情况，可能补一个 `daily-idempotence`

### C. 外部环境用例要“正式化”

外部环境验证不能再靠“记得跑一下某条 shell”。每个外部环境套件都必须有：

1. 固定 case 名
2. 固定入口命令
3. 固定结果结构
4. 固定 runbook 和失败回退路径

首批套件名：

- `ppe-repo`
- `ppe-npm-installed`
- `ppe-ops`
- `ppe-real-llm`

## 命令面

### 默认：只跑本地硬门禁

```bash
pnpm run release:gate
```

行为：

- 完整跑本地必跑项
- 任意本地必跑失败，直接失败

### 按需追加外部环境套件

```bash
pnpm run release:gate -- --external ppe-repo --external ppe-npm-installed
```

第一版只支持重复的 `--external <case>`，不支持 CSV。原因很直接：

- parser 更简单
- shell 包装更稳
- 出错面更小

行为：

- 本地门禁仍然先跑
- 只执行显式请求的外部环境 case
- 被请求的外部环境 case 全部按阻塞项处理

### “今天全跑”

```bash
pnpm run release:gate -- \
  --external ppe-repo \
  --external ppe-npm-installed \
  --external ppe-ops \
  --external ppe-real-llm
```

这就是“今天我要求都跑”的固定表达方式。

## 结果产物

每次发版门禁运行都必须写两类结果：

1. 控制台 summary
2. JSON 结果文件

结果文件位置固定为：

```text
.release-gate/<run-id>/summary.json
```

最小 JSON 结构：

```json
{
  "runId": "20260702-123456",
  "overallStatus": "success",
  "local": {
    "status": "success",
    "checks": []
  },
  "external": {
    "requested": ["ppe-repo"],
    "checks": []
  }
}
```

每条检查记录至少要包含：

- `name`
- `required` 或 `conditional`
- `status`
- `durationMs`
- `command`
- 相关输出路径

## 文档调整

文档要从“描述测试资产”升级成“定义发版门禁”。

### 更新

1. `docs/release-tests/README.md`
   - 明确拆成“本地必跑”和“外部按需”
   - 把新入口写成主入口
2. `docs/local-release-verification.md`
   - 改成指向新的 release gate
3. `docs/deployment-cli.md`
   - 从命令手册反链到 ops/versioning gate

### 新增

1. `docs/release-tests/local/ops-versioning/plan.md`
2. `docs/release-tests/local/ops-versioning/runbook.md`
3. `docs/release-tests/external/README.md`
4. `docs/release-tests/external/ppe/plan.md`
5. `docs/release-tests/external/ppe/runbook.md`

## 测试矩阵

### 本地必跑矩阵

| 分组 | 用例 | 是否阻塞 |
|---|---|---|
| 静态检查 | typecheck/build/test/lint/script tests/diff-check | 是 |
| 发布 rehearsal | `release.mjs --dry-run` | 是 |
| 构建模式 | full / incremental / resume / backfill | 是 |
| 本地部署 | repo-checkout / verdaccio / shared-gateway | 是 |
| 本地真实 LLM | shared-gateway + `real-llm` | 是 |
| 本地运维 | dashboard / gateway / project-state / serve / compat / review / notify / repair | 是 |
| 本地编排 | daily bootstrap + rerun 幂等断言 | 是 |

### 外部按需矩阵

| 分组 | 用例 | 请求后是否阻塞 |
|---|---|---|
| PPE 部署 | repo-checkout / npm-installed | 是 |
| PPE 运维 | gateway/project-state 版本流 | 是 |
| PPE 真实 LLM | coco/cli-spawn | 是 |
| 其他指定环境 | 与 PPE 同契约 | 是 |

## 常规运维命令覆盖表

下面这张表不是“实现建议”，而是门禁必须覆盖到的命令清单。

| 命令/脚本 | 覆盖方式 | 默认是否阻塞 |
|---|---|---|
| `understand-anyway build` 全量 | 本地 direct case | 是 |
| `understand-anyway build --incremental` | 本地 direct case | 是 |
| `understand-anyway build --resume` | 本地 direct case | 是 |
| `understand-anyway build --backfill` | 本地 direct case | 是 |
| `understand-anyway dashboard build-dist` | 本地 direct case | 是 |
| `understand-anyway dashboard start` | 本地 direct case | 是 |
| `understand-anyway dashboard stop` | 本地 direct case | 是 |
| `understand-anyway dashboard status` | 本地 direct case | 是 |
| `understand-anyway gateway start` | 本地 direct case | 是 |
| `understand-anyway gateway stop` | 本地 direct case | 是 |
| `understand-anyway gateway publish` | 本地 direct case | 是 |
| `understand-anyway gateway set-stable` | 本地 direct case | 是 |
| `understand-anyway gateway rollback` | 本地 direct case | 是 |
| `understand-anyway gateway list` | 本地 direct case | 是 |
| `understand-anyway gateway gc` | 本地 direct case | 是 |
| `understand-anyway project-state publish` | 本地 direct case | 是 |
| `understand-anyway project-state set-stable` | 本地 direct case | 是 |
| `understand-anyway project-state rollback` | 本地 direct case | 是 |
| `understand-anyway project-state list` | 本地 direct case | 是 |
| `understand-anyway project-state gc` | 本地 direct case | 是 |
| `understand-anyway compat` | 本地 direct case | 是 |
| `understand-anyway review-graph-health` | 本地 direct case | 是 |
| `understand-anyway notify nightly` | 本地 direct case 或通过 `daily-update` 断言 | 是 |
| `understand-anyway serve --project` | 本地 direct case | 是 |
| `understand-anyway repair llm-failures` | 本地 direct case | 是 |
| `understand-anyway repair llm-graph-failures` | 本地 direct case | 是 |
| `scripts/daily-update.sh` | 本地 direct case | 是 |
| `scripts/nightly-project-sync.sh` | 本地 direct case | 是 |
| `scripts/refresh-prod-server.sh` | 本地 direct case | 是 |
| `ppe-repo` | 外部环境 case | 否，按请求升级为是 |
| `ppe-npm-installed` | 外部环境 case | 否，按请求升级为是 |
| `ppe-ops` | 外部环境 case | 否，按请求升级为是 |
| `ppe-real-llm` | 外部环境 case | 否，按请求升级为是 |

## 失败语义

1. 任一本地必跑项失败，本次发版直接失败
2. 任一被请求的外部环境 case 失败，本次发版直接失败
3. 未请求的外部环境 case 记为 `not-run`，不能记成 `pass`
4. 本地必跑项缺前置条件时，记失败，不允许跳过
5. 被请求的外部环境 case 缺前置条件时，记失败，不允许跳过

## 推进阶段

### Phase 1

1. 加统一 orchestrator
2. 把已有本地 case 收进新入口
3. 补本地 ops/versioning case
4. 更新文档，把 release gate 变成唯一发版前入口

### Phase 2

1. 补外部环境 case
2. 补环境级结果汇总
3. 固化“全跑”示例

## 风险

1. 本地门禁会变慢，但这是 release gate，不是日常 edit-compile loop
2. 外部环境本来就比本地更不稳定，所以更需要显式建模，而不是靠经验操作
3. 真实 LLM 可能因为环境原因失败，但如果声称 release 覆盖了 real-LLM 能力，就不能把它从本地必跑门禁里删掉

## 仍待实现阶段决定的小点

这些不是策略问题，只是实现落点问题：

1. `daily-idempotence` 是并进 `local-delivery-tests.mjs` 还是拆成旁路脚本
2. 本地 ops/versioning 是并进 `local-delivery-tests.mjs` 还是单独放到 `scripts/release-gate-ops.mjs`

已经固定、不再讨论的点：

- 本地门禁必跑
- 外部环境按需启用，但一旦启用就是阻塞项
- 外部 suite 用重复的 `--external` 旗标
- 结果文件路径固定为 `.release-gate/<run-id>/summary.json`
