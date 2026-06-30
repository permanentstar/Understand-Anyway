# local / shared-gateway / runbook

> 常规交付走 `pnpm run delivery:local --only shared-gateway`（自动建双项目 + LLM 富化 + token 隔离 + 翻新 gateway 回归）。验收人可加 `--keep-running` 让脚本结束后保留 gateway，再人眼复核浏览器 UI。本 runbook 仅供脚本失败时的手工排查。

前置：[local/npm-verdaccio](../npm-verdaccio/runbook.md) 已验证通过。

## 步骤

```bash
export UA_REPO_ROOT="$(git rev-parse --show-toplevel)"
export UA_PROJECTS_ROOT="$HOME/understand-projects-shared"
export UA_PLUGIN_ROOT="$HOME/.understand-anything/repo/understand-anything-plugin"
export UA_LLM_PROVIDER=mock

mkdir -p "$UA_PROJECTS_ROOT/src"

# 1. 准备两个项目源码（mini-project 已存在 / mini-project-b 复制改名即可）
cp -R "$UA_REPO_ROOT/packages/core/fixtures/sample-repo" "$UA_PROJECTS_ROOT/src/mini-project"
cp -R "$UA_REPO_ROOT/packages/core/fixtures/sample-repo" "$UA_PROJECTS_ROOT/src/mini-project-b"

# 2. 注册项目元数据
node "$UA_REPO_ROOT/packages/cli/dist/cli.js" init "$UA_PROJECTS_ROOT/src/mini-project" \
  --project mini-project \
  --repo-path '${projectsRoot}/src/${projectId}'
node "$UA_REPO_ROOT/packages/cli/dist/cli.js" init "$UA_PROJECTS_ROOT/src/mini-project-b" \
  --project mini-project-b \
  --repo-path '${projectsRoot}/src/${projectId}'

# 3. 走 daily-update 把两个项目都跑一遍
"$UA_REPO_ROOT/scripts/daily-update.sh" \
  --host 0.0.0.0 --port 18666 \
  --deploy-profile ppe --profile small
```

## 浏览器验收

1. `http://127.0.0.1:18666/` 看到两张卡片，每张 href 含 token。
2. 分别打开两个 dashboard，知识图谱正常。
3. 把 mini-project 的 token 替换成 mini-project-b 的 token 访问 mini-project API → 期望 403。
4. 用 `understand-anyway gateway publish <newVid> --projects-root "$UA_PROJECTS_ROOT" --stable` 翻新一次 gateway，再次访问两个项目仍可正常打开。

## 失败兜底

- 串号或 token 失效：检查 `gateway/registry.json` 中两项目的 `prodToken` 是否区分写入，以及 project-router 的 token 校验。
- HTML transform 失效：用浏览器 Network 面板复核 `/project/<id>/assets/...` 路径。

## Pass criteria

本用例视作通过，当且仅当：

- §1 ~ §3 所有命令退出码 `0`，`gateway/registry.json` 同时包含 `mini-project` 与 `mini-project-b` 两条记录，且各自 `prodToken` 不为空且互不相等；
- "浏览器验收" §1 portal 同时显示两张卡片，每张卡片 `href` 中的 `token` 与该项目在 registry 中的 `prodToken` 一致；
- "浏览器验收" §2 两个 dashboard 均能完整渲染知识图谱，Console 无 4xx、无未捕获异常；
- "浏览器验收" §3 token 互换访问的请求返回 HTTP `403`（不能 200，也不能跨项目落到对方数据）；
- "浏览器验收" §4 翻新 gateway 后再次访问两个项目仍能正常打开，旧 token 不再有效、新 `current` 软链指向新 `<newVid>`。

任一条不满足即视为失败；token 隔离失败必须当作阻塞缺陷处理，不允许向上推进 remote 层。
