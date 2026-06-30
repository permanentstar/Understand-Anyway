# local / repo-checkout / runbook

> 常规交付走 `pnpm run delivery:local --only repo-checkout`（自动 HTTP 断言）。本 runbook 仅供脚本失败时的手工排查与浏览器人眼复核。

按序执行，每步必须退出码 0 且通过断言才能进入下一步。

## 0. 前置环境

```bash
# 仓库根
export UA_REPO_ROOT="$(git rev-parse --show-toplevel)"
# Pick any writable directory; this example sits next to the checkout.
export UA_PROJECTS_ROOT="${UA_REPO_ROOT}/.tmp/understand-projects"
# upstream plugin
export UA_PLUGIN_ROOT="$HOME/.understand-anything/repo/understand-anything-plugin"
# mock LLM provider
export UA_LLM_PROVIDER=mock

# CLI fallback：repo 部署没有全局 understand-anyway 命令，统一走 packages/cli/dist/cli.js
ua() { node "$UA_REPO_ROOT/packages/cli/dist/cli.js" "$@"; }
```

## 1. repo 构建

```bash
cd "$UA_REPO_ROOT"
pnpm install
pnpm build
pnpm typecheck
pnpm test
pnpm test:scripts
```

## 2. 项目元数据

```bash
ua init "$UA_PROJECTS_ROOT/src/mini-project" \
  --project mini-project \
  --repo-path '${projectsRoot}/src/${projectId}'
```

## 3. 旧状态处理

旧布局不自动迁移。若已有扁平 `mini-project/.understand-anything/` 或旧
`config/projects.json`，先清理/手动迁移到新目录，再从 `init/build/publish`
继续；不要让新旧布局混跑。

## 4. 单项目 build + publish

```bash
# 4.1 build（写入临时 graph 到 state root 的 .understand-anything/）
ua build \
  --project mini-project \
  --plugin-root "$UA_PLUGIN_ROOT" \
  --llm-provider mock

# 4.2 build dashboard-dist
ua dashboard build-dist \
  --project mini-project \
  --plugin-root "$UA_PLUGIN_ROOT" \
  --rebuild-dashboard

# 4.3 publish 进版本目录
VID=$(date +%Y%m%d%H%M%S)
ua project-state publish "$VID" \
  --project mini-project \
  --source-root "$UA_PROJECTS_ROOT/src/mini-project" \
  --stable
```

## 5. 注册到 gateway

```bash
"$UA_REPO_ROOT/scripts/refresh-prod-server.sh" \
  --host 0.0.0.0 \
  --port 18666 \
  --deploy-profile ppe
```

## 6. 浏览器验证

打开 `http://127.0.0.1:18666/`：

| 验收点 | 期望 |
|--------|------|
| Portal 首页 | mini-project 卡片可见 |
| 卡片 href | 含 `?token=...` |
| 点击跳转 | 直接进入 dashboard，**不卡 loading** |
| Network `/project/mini-project/assets/*.js` | HTTP 200 |
| Network `/project/mini-project/knowledge-graph.json` | HTTP 200 + 含 token |
| Console | 无 404，无未捕获错误 |

## 7. nightly 全链路

```bash
"$UA_REPO_ROOT/scripts/daily-update.sh" \
  --host 0.0.0.0 \
  --port 18666 \
  --deploy-profile ppe \
  --profile small
```

验证：

```bash
jq '.projects[] | {id, overallStatus, currentVersion}' \
  "$UA_PROJECTS_ROOT/gateway/operations/nightly-latest.json"
```

期望 mini-project `overallStatus=success` 且 `currentVersion` 为新 vid。

## 8. 目录复核

按 [expected-layout.md](./expected-layout.md) 执行检查命令。

## 9. 清理

```bash
ua gateway stop --projects-root "$UA_PROJECTS_ROOT"
```

## Pass criteria

本用例视作通过，当且仅当下面每条都满足：

- §1 所有命令退出码 `0`（`pnpm install / build / typecheck / test / test:scripts`）；
- §4 的 `build` / `dashboard build-dist` / `project-state publish` 退出码 `0`，state root 出现 `versions/<VID>/.understand-anything/` 与 `current` 软链；
- §5 `refresh-prod-server.sh` 退出码 `0`，端口 18666 监听存活；
- §6 浏览器验收表 6 行全部命中期望（含 Network 0 个 4xx、Console 0 错误）；
- §7 `nightly-latest.json` 中 mini-project 的 `overallStatus="success"` 且 `currentVersion` 等于 §4.3 写入的 `VID`；
- §8 按 expected-layout 复核命令全部退出码 `0` 且差异为空。

任一条不满足即视为失败，回到对应章节排查，不向上推进。
