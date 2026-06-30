# local / npm-verdaccio

## 目标

把 repo-checkout 已验证过的代码版本固化，在本地 npm registry (Verdaccio) 上模拟一次完整 publish → install 流程。

进入本用例的前提：[local/repo-checkout](../repo-checkout/plan.md) 全部验收点通过、且当前 git tree 干净（无未提交修改）。

## 范围

- 通过 `scripts/release.mjs` 按依赖顺序逐包发布到 Verdaccio。
- 干净目录 `pnpm add @understand-anyway/cli` 拉包。
- 拉包后跑 `help / compat / build / dashboard build-dist / dashboard start / project-state publish / gateway publish`。
- 验证 `workspace:*` 在 publish 阶段被替换为具体版本号。

## 验收点

1. Verdaccio storage 中包含全部 6 个公开包：`plugin-api / core / gateway / provider-feishu-auth / provider-feishu-sheets / cli`。
2. 安装目录中 `node_modules/@understand-anyway/cli/package.json` 的依赖全部是版本号，没有 `workspace:*`。
3. 在 mini-project 上跑出的 versioned 布局与 [repo-checkout/expected-layout.md](../repo-checkout/expected-layout.md) 完全一致。
4. 浏览器再次访问 `http://127.0.0.1:18666/` 行为与 repo-checkout 用例一致（含 token、HTML transform、SPA 资源 200）。

## 阻塞与切回

- 任何一项验收点失败：把 commit hash 与 Verdaccio storage 一并保留，回到 repo-checkout 用例对应步骤定位。
- 在跑通本用例前，禁止进入真实 npm 发布验证。
