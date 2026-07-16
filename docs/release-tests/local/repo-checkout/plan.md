# local / repo-checkout 部署验证

## 目标

在不发布任何 npm 包的前提下，直接基于 repo checkout 把单项目（mini-project）按**标准版本化部署形态**跑通：

- `pnpm install && pnpm build` → 可用的 `understand-anyway` CLI（fallback 到 `packages/cli/dist/cli.js`）。
- `<UA_PROJECTS_ROOT>/gateway/config/projects.json` 配置 → `nightly-project-sync.sh` 自动发现项目。
- 单次 build → `project-state publish` 把图谱产物、`dashboard-dist/` 装进 `versions/<vid>/`。
- `current` / `stable` 软链指向最新版本，`gateway/registry.json` 解析这些指针写入 `prodDistDir`。
- 共享 gateway 在 `/project/mini-project/` 路由下能加载 HTML、资源、`knowledge-graph.json`。
- portal 首页 mini-project 卡片携带 prodToken，点击直达不 302。

## 范围

| In | Out |
|----|-----|
| 单项目（mini-project） | 多项目共享 gateway 拓扑（见 shared-gateway 用例） |
| mock LLM provider | 真实 `@understand-anyway/provider-trae-cli-v2` |
| 本机磁盘 | 远端机器 |
| Vite 产物 base 路径修复 | npm 安装/发布链路 |

## 触达组件

- `packages/gateway/src/prod-static.ts`：SPA HTML transform，把绝对资源前缀重写为 `publicPath`。
- `packages/gateway/src/portal-view.ts`：portal 卡片 href 拼 `?token=<prodToken>`。
- `packages/gateway/src/project-router.ts`：无 token 重定向到项目页。
- `packages/cli/src/gateway/project-state.ts`：`project-state publish` CLI 入口。
- `scripts/refresh-prod-server.sh`：解析 `current` 软链 → `versions/<vid>/dashboard-dist/`。
- `scripts/nightly-project-sync.sh`：build 后调 `project-state publish`。
- `<UA_PROJECTS_ROOT>/gateway/config/projects.json`：项目元数据。

## 验收点

1. `<UA_PROJECTS_ROOT>/projects/mini-project/` 必须满足 [expected-layout.md](./expected-layout.md)。
2. `gateway/registry.json` 中 `prodDistDir` 指向 `versions/<vid>/dashboard-dist`。
3. 浏览器访问 `http://127.0.0.1:18666/` 看到 portal 卡片，点击直达 mini-project dashboard，**不卡 loading**。
4. 浏览器 Network 面板里 `index-*.js`、`*.css` 请求路径为 `/project/mini-project/assets/...`，HTTP 200。
5. `daily-update.sh --host 0.0.0.0 --port 18666 --deploy-profile ppe --llm-profile traex` mock LLM 全链路退出码 0。
6. `aggregate-nightly` 写入 `<UA_PROJECTS_ROOT>/gateway/operations/nightly-latest.json` 含 mini-project 条目，`overallStatus=success`。

## 失败兜底

- 任意验收点失败：回到对应 runbook 步骤，先确认目录布局符合 expected-layout，再排查 HTML transform / token / publish 调用链。
- 不允许跳过验收点继续进入下一层用例。
