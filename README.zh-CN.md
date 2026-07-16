# Understand-Anyway

[English](README.md) | 简体中文

[![License](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![Node.js](https://img.shields.io/badge/Node.js-20%2B-339933.svg?logo=node.js&logoColor=white)](https://nodejs.org/)
[![pnpm](https://img.shields.io/badge/pnpm-9%2B-F69220.svg?logo=pnpm&logoColor=white)](https://pnpm.io/)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.x-3178C6.svg?logo=typescript&logoColor=white)](https://www.typescriptlang.org/)

> **把多个 Understand-Anything 项目的构建、发布、服务与定时同步，收敛到同一套运行层里。**

Understand-Anything 很擅长“理解一个项目”。真正落到部署场景，缺的往往是外围那一层：重复 build、版本化发布、共享只读 gateway、定时刷新任务，以及按环境切换的集成能力。Understand-Anyway 就是补这层运行与编排能力。

它不是新的分析引擎，也不替代上游项目；它是在上游能力之上，补出一套适合多项目长期运行的 CLI、gateway 和 release 流程。

## ✨ 核心能力

- **多项目编排**：把多个仓库放进同一套 build / refresh 运行模型里。
- **只读 gateway / portal**：通过共享入口暴露项目图谱与 dashboard。
- **版本化运行时发布**：项目与 gateway 都可以发布不可变版本，并原子切换 `current` / `stable`。
- **定时同步**：支持 daily / nightly 更新流，不必手工盯着重跑。
- **可插拔 provider**：认证、组织策略、记录、LLM、Embedding、通知都可替换，不需要重编译核心。
- **增量与回补工作流**：既能做日常增量刷新，也能在状态漂移时执行重建或修复路径。

## ✅ 适合什么场景

- 你要为多个仓库提供共享的知识门户。
- 你需要稳定的 build / publish / rollback 流程，而不是一堆临时脚本。
- 你希望核心保持 OSS，环境相关集成通过插件接入。

## ❌ 不适合什么场景

- 你只想在 IDE 里做单仓交互式分析。
- 你想找的是新的图谱分析引擎，而不是运行编排层。
- 你需要这个仓库直接内置上游 plugin。

## 快速开始

环境要求：

- Node.js **>= 20**
- pnpm **>= 9**
- 本地已安装上游
  [Understand-Anything](https://github.com/Egonex-AI/Understand-Anything)
  plugin

```bash
git clone https://github.com/permanentstar/Understand-Anyway.git
cd Understand-Anyway
pnpm install
pnpm -r build

export UA_PLUGIN_ROOT="$HOME/.understand-anything/repo/understand-anything-plugin"
node packages/cli/dist/cli.js --help
```

如果你要看完整部署路径，请先读
[docs/deployment.md](docs/deployment.md)。如果你要做本地端到端演练，可以看
[docs/local-release-verification.md](docs/local-release-verification.md)，或直接跑
`pnpm run delivery:local`。

## 文档地图

- [部署架构](docs/deployment.md)：运行态模型、配置分层、命令族设计与 gateway 版本化。
- [Deployment CLI 手册](docs/deployment-cli.md)：`deploy.yaml` 模板和高频运维场景。
- [发版测试矩阵](docs/release-tests/README.md)：local / external release gate 覆盖面与入口。
- [本地发布验证](docs/local-release-verification.md)：本地 registry 演练与 clean-install 验证。
- [Plugin API](packages/plugin-api/README.md)：provider SPI 与运行时工厂约定。
- [Agent 指南](AGENTS.md)：给 coding agent 的仓库地图、约束和验证要求。

## 仓库结构

```text
docs/                        # 对外文档、部署说明、发版验证
packages/cli/                # CLI 入口与编排接线
packages/core/               # 构图流水线与图处理
packages/gateway/            # shared gateway、portal、runtime 发布
packages/plugin-api/         # provider SPI 合约
packages/provider-*/         # OSS provider 与 runtime 适配
scripts/                     # 运维、发版、回归与脚本测试
```

## 许可

MIT。见 [LICENSE](LICENSE) 与 [NOTICE](NOTICE)。
