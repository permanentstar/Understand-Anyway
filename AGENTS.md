# AGENTS.md

本文件是 agent 进入 `Understand-Anyway` 仓库后的入口指南。先读这里，再按需跳转到 README、部署文档和 SPI 文档。

## 项目定位

`Understand-Anyway` 是建立在
[Understand-Anything](https://github.com/Egonex-AI/Understand-Anything) 之上的多项目部署与编排层：它负责 build、publish、serve、sync 这些运行侧问题，不负责替代上游的单仓交互式分析体验。

## 必读顺序

1. `README.md` / `README.zh-CN.md`
   - 面向使用者的产品说明、能力边界和文档导航首页。
2. `docs/deployment.md`
   - 部署架构、运行态模型、配置分层、命令族设计。
3. `docs/deployment-cli.md`
   - `deploy.yaml` 模板、高频运维场景、YAML 与 CLI 对照。
4. `docs/release-tests/README.md`
   - 发版前验证矩阵与 local / external case 入口。
5. `docs/local-release-verification.md`
   - 本地 registry 演练与 clean-install 验证。
6. `packages/plugin-api/README.md`
   - provider SPI；涉及 provider / integration 工作时必读。

## 仓库地图

- `packages/cli`：CLI 入口，调度 build / serve / publish / repair / notify。
- `packages/core`：构图流水线、增量 / backfill、graph 处理。
- `packages/gateway`：shared gateway、portal、版本化 runtime。
- `packages/plugin-api`：Auth / OrgPolicy / Record / Llm / Embedding / Notify SPI。
- `packages/provider-*`：OSS provider 实现和 runtime/provider 适配。
- `scripts`：运维、发版、回归与脚本测试入口。
- `docs`：对外文档、runbook、release test 说明。

## 常用命令

```bash
pnpm install
pnpm -r typecheck
pnpm -r test
pnpm -r build
pnpm test:scripts
pnpm lint:scripts
```

需要做本地端到端交付演练时，再跑：

```bash
pnpm run delivery:local
```

## 测试与文件组织

- `packages/*/src/` 下的单测采用 co-locate：`*.test.ts`
- 黑盒脚本测试集中在 `scripts/__tests__` 与 `packages/cli/scripts/__tests__`
- 修改 provider SPI、deploy/release 脚本、gateway 发布路径时，优先补对应测试，不要只改 happy path

## 文档与公开信息约束

- 公共文档不要暴露内网标识、真实个人账号、生产 IP、本地绝对路径。
- 公共文档不要把本地 `next` / prerelease 版本写成对外可用版本。
- 路径示例优先使用 `$UA_PROJECTS_ROOT` 或通用占位符。
- 对外文档尽量链接正式文档，不引用临时 `docs/superpowers/` 产物。

## 工程硬约束

- `portalAssets` provider 必须优先尊重 `contribution.assetsDir`；`portalAssetsSubdir` 只应用于约定目录资产。
- 外部 record schema 优先保持向后兼容；不要缩水既有 header。
- 发布前避免大规模机械式 layout 调整；如果移动 `scripts/` 路径，必须保留兼容 shim。
- 不要擅自重置、回滚或覆盖用户未提交改动。

## 完成前验证

- 文档改动：至少跑敏感词 / 绝对路径扫描和 `git diff --check`
- 脚本改动：至少跑 `pnpm lint:scripts` 与 `pnpm test:scripts`
- 包代码改动：运行受影响 package 的 `typecheck / test / build`
- 跨入口或发布链路改动：再补 repo 级验证，必要时跑 `pnpm run delivery:local`
