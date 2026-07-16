# Release Gate Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 增加统一的发版门禁入口，强制执行本地必跑矩阵，并为外部环境按需套件提供正式入口。

**Architecture:** 新增 `scripts/release-gate.mjs` 作为总 orchestrator，复用现有 `release.mjs`、`local-delivery-tests.mjs` 和脚本测试；新增少量本地 runtime case 脚本覆盖 build mode、ops/versioning 和 daily idempotence。外部环境第一阶段只实现入口和结果汇总，不默认执行。

**Tech Stack:** Node.js ESM 脚本、现有 CLI (`packages/cli/dist/cli.js`)、Vitest-less 脚本测试、现有 runbook 文档。

---

### Task 1: Release Gate 入口

**Files:**
- Create: `scripts/release-gate.mjs`
- Modify: `package.json`
- Test: `scripts/__tests__/release-gate.test.mjs`

- [ ] 写失败测试：校验 `release-gate` 默认本地矩阵、重复 `--external` 解析和帮助输出
- [ ] 运行失败测试，确认当前仓库没有该入口
- [ ] 实现 `scripts/release-gate.mjs`
- [ ] 给根 `package.json` 增加 `release:gate`
- [ ] 运行脚本测试，确认入口行为通过

### Task 2: 本地 build mode / repair case

**Files:**
- Create: `scripts/release-gate-build-modes.mjs`
- Modify: `docs/release-tests/README.md`

- [ ] 基于临时 `projectsRoot + git init fixture` 实现 full/resume/incremental/backfill/repair 探针
- [ ] 失败即退出非 0，成功输出 summary
- [ ] 把该 case 挂入 `release-gate.mjs`

### Task 3: 本地 ops/versioning case

**Files:**
- Create: `scripts/release-gate-ops.mjs`
- Add: `docs/release-tests/local/ops-versioning/plan.md`
- Add: `docs/release-tests/local/ops-versioning/runbook.md`

- [ ] 覆盖 `dashboard build-dist/start/stop/status`
- [ ] 覆盖 `gateway publish/set-stable/rollback/list/gc`
- [ ] 覆盖 `project-state publish/set-stable/rollback/list/gc`
- [ ] 覆盖 `compat`、`review-graph-health`、`notify nightly`、`serve --project`
- [ ] 把该 case 挂入 `release-gate.mjs`

### Task 4: 本地 daily idempotence case

**Files:**
- Create: `scripts/release-gate-daily.mjs`
- Modify: `docs/deployment-cli.md`

- [ ] 用临时项目跑一次 `daily-update.sh`
- [ ] 再跑一次无变更 `daily-update.sh`
- [ ] 断言第二次 nightly 为 skip / overall success
- [ ] 把该 case 挂入 `release-gate.mjs`

### Task 5: 外部环境入口与文档

**Files:**
- Add: `docs/release-tests/external/README.md`
- Add: `docs/release-tests/external/ppe/plan.md`
- Add: `docs/release-tests/external/ppe/runbook.md`
- Modify: `docs/local-release-verification.md`

- [ ] 在 `release-gate.mjs` 中增加重复 `--external <case>` 参数
- [ ] 第一阶段把外部 case 标记为“显式请求才执行”
- [ ] 若请求了但未配置运行前提，直接失败
- [ ] 文档中明确“本地必跑 / 外部按需”

### Task 6: 验证

**Files:**
- Test: `scripts/__tests__/release-gate.test.mjs`
- Test: `scripts/__tests__/local-delivery-tests.test.mjs`
- Test: `scripts/__tests__/daily-update.test.mjs`
- Test: `scripts/__tests__/nightly-project-sync.test.mjs`

- [ ] 运行新增脚本测试
- [ ] 运行受影响既有脚本测试
- [ ] 跑一次 `pnpm run release:gate`（至少在 mock/profile 可用前提下）
- [ ] 更新最终文档说明与结果示例
