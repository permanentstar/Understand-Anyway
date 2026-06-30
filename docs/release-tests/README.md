# Release Tests 总览

本目录汇总 Understand-Anyway 的部署/发布验证用例。所有手动测试计划、操作手册、一次性脚本都收口在这里，不再散落到其他目录。

单元/契约测试仍由 Vitest 在 `packages/*/src/**/*.test.ts` 与 `scripts/__tests__/**` 里跑，不进入本目录。

## 本地交付测试集（必跑）

每次研发交付前必须执行：

```bash
export UA_PLUGIN_ROOT="$HOME/.understand-anything/repo/understand-anything-plugin"  # 或本机实际路径
pnpm build
pnpm run delivery:local                 # oss profile，case 3 用内置 mock LLM
# 拿真实 LLM 跑一次:
pnpm run delivery:local --profile real-llm           # 需要本机 PATH 上有 `llm` CLI
# 单层调试:
pnpm run delivery:local --only repo-checkout         # 或 verdaccio / shared-gateway
# 完成后保留 gateway 让验收人人工 review:
pnpm run delivery:local --keep-running
```

退出码：0=全通过；1=用例失败；2=前置不满足（缺 `UA_PLUGIN_ROOT` / Node<20 / 缺 `pnpm` / `--profile real-llm` 缺 `llm`）。
脚本自身覆盖三层：(1) repo 构建 + 直接跑 + portal/项目路由 HTTP 断言；(2) Verdaccio 发 6 包 + 干净目录安装 + 复跑核心 CLI；(3) 多项目共享 gateway + LLM 富化产物断言（mock 或 cli-spawn）+ token 隔离 + 翻新 gateway 回归。本目录下的 runbook 仅在脚本失败、需要人工排查、或验收方要人眼复核 UI 时使用。

## 本地测试结构

```
docs/release-tests/
├── README.md                                     # 本文件
├── local/                                        # 第一层：本机闭环
│   ├── repo-checkout/                            # repo clone + 直接跑
│   ├── npm-verdaccio/                            # 本地 npm registry 模拟
│   └── shared-gateway/                           # 多项目共享 gateway 拓扑
```

| 层级 | 目录 | 入口安装方式 | 适用阶段 |
|------|------|--------------|---------|
| local | repo-checkout | `git clone` + `pnpm install && pnpm build` | 开发态最快闭环 |
| local | npm-verdaccio | `pnpm publish` 到 Verdaccio + `pnpm add` | release 前包形态回归 |
| local | shared-gateway | 复用 repo-checkout 二进制 | 多项目拓扑、路由、HTML transform 验证 |

## 用例状态表

| # | 层级 | 用例 | 触达组件 | 验证方式 | 状态 | 阻塞 |
|---|------|------|---------|---------|------|------|
| 1 | local | repo-checkout 单项目部署 | scripts + cli + gateway | `pnpm run delivery:local --only repo-checkout` (HTTP 断言) | 必跑（auto） | — |
| 2 | local | versioned 项目布局 | `project-state publish` | runbook + 单测 | 待 | #1 |
| 3 | local | shared gateway 多项目 + LLM | portal / project-router + LLM | `pnpm run delivery:local --only shared-gateway` | 必跑（auto） | #2 |
| 4 | local | Vite assets 子路径 transform | prod-static | 浏览器 + 单测 | 待 | #2 |
| 5 | local | daily-update 全链路 mock LLM | daily-update.sh | 文件断言 | 待 | #2 |
| 6 | local | Verdaccio 本地 npm install | release pipeline | `pnpm run delivery:local --only verdaccio` | 必跑（auto） | #5 |

## 用例链接

- [local/repo-checkout/plan.md](./local/repo-checkout/plan.md)
- [local/repo-checkout/runbook.md](./local/repo-checkout/runbook.md)
- [local/repo-checkout/expected-layout.md](./local/repo-checkout/expected-layout.md)
- [local/npm-verdaccio/plan.md](./local/npm-verdaccio/plan.md)
- [local/npm-verdaccio/runbook.md](./local/npm-verdaccio/runbook.md)
- [local/shared-gateway/plan.md](./local/shared-gateway/plan.md)
- [local/shared-gateway/runbook.md](./local/shared-gateway/runbook.md)

## 共通约束

- 任何用例都必须以**标准部署形态**执行：
  - 项目 state root 使用 `versions/<vid>/{.understand-anything,dashboard-dist}` + `source-mirror/<vid>` + `current` / `stable` 软链 + `versioned-state.json`。
  - 共享 gateway 通过 `gateway/runtime/releases/<vid>` + `current` 软链运行。
  - 项目元数据写在 `<UA_PROJECTS_ROOT>/gateway/config/projects.json`，`gateway/registry.json` 仅作为运行态发现。
- 禁止任何临时/扁平目录绕过。
- 当某层用例失败，回到下层用例修复，不允许跨层跳过。
- 每个 runbook 必须能在干净环境（重置 `UA_PROJECTS_ROOT`、重启 gateway）下重复执行得到相同结果。
