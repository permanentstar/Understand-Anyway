# local / shared-gateway

## 目标

在 npm-verdaccio 用例通过后，把同一台 Verdaccio 装出来的 CLI 用于多项目共享 gateway 拓扑（mini-project + 至少一个额外项目，例如 mini-project-b），验证：

- 共享 gateway 进程下，每个项目有独立 `versions/<vid>/` 目录、`current` 软链、`prodDistDir`。
- portal 首页能并排展示多张项目卡片，token 各自携带。
- `/project/<id>/` 路由互不串扰：A 项目 token 不能访问 B 项目数据 API。
- `gateway publish` / `gateway set-stable` / `gateway rollback` 不会污染项目版本目录。

## 范围

| In | Out |
|----|-----|
| 至少两个项目并行注册 | 跨机器 |
| portal 多卡片渲染 | SSO / 真实 IdP |
| Vite HTML transform 在多项目下的稳定性 | npm 公开发布 |

## 验收点

1. `<UA_PROJECTS_ROOT>/gateway/registry.json` 列出至少两个项目，且 `prodDistDir` 各自指向自己的 `versions/<vid>/dashboard-dist`。
2. 浏览器分别访问两个项目入口都能正常加载、知识图谱可见。
3. 把 A 项目的 `?token=` 替换成 B 项目的 token 后访问 A 项目 API，返回 403。
4. `gateway publish <newVid>` 触发软链翻新后，项目页仍可访问且不需要刷新 token。

## 阻塞与切回

- 任何一项失败：回到 [local/npm-verdaccio](../npm-verdaccio/plan.md) 排查共享 gateway 配置或 HTML transform 逻辑，禁止进入真实 npm 发布验证。
