# local / npm-verdaccio / runbook

> 常规交付走 `pnpm run delivery:local --only verdaccio`（自动起 Verdaccio + 发包 + 干净目录安装 + 复跑 CLI）。本 runbook 仅供脚本失败时的手工排查。

完整操作复用 [docs/local-release-verification.md](../../../local-release-verification.md) 第 3 章。本文件只记录与本测试三层结构相关的差异。

## 入口

```bash
export UA_REPO_ROOT="$(git rev-parse --show-toplevel)"
export UA_PROJECTS_ROOT="$(mktemp -d -t ua-verdaccio-XXXXXX)/projects"
export UA_PLUGIN_ROOT="$HOME/.understand-anything/repo/understand-anything-plugin"
export UA_LLM_PROVIDER=mock
```

执行顺序：

1. 走 `local-release-verification.md §3.1 ~ §3.3` 启动 Verdaccio，用 `scripts/release.mjs` 发布 6 个包。
2. 在干净目录中安装 `@understand-anyway/cli`。
3. 把 mini-project 准备到 `$UA_PROJECTS_ROOT/src/mini-project`，重复 [repo-checkout/runbook.md](../repo-checkout/runbook.md) §2 ~ §8，但所有 `ua` 命令改用 `pnpm exec understand-anyway`。
4. 按 [expected-layout.md](../repo-checkout/expected-layout.md) 复核目录。

不重复正文，避免一处改两处错。

## 必填检查清单

| 步骤 | 命令 | 预期 |
|------|------|------|
| 包发布 | `node scripts/release.mjs patch --skip-git --registry "$LOCAL_REGISTRY"` | 6 个公开包发布成功 |
| 包内容 | `cat node_modules/@understand-anyway/cli/package.json \| jq .dependencies` | 无 `workspace:*` |
| help | `pnpm exec understand-anyway --help` | 输出 help 文本 |
| compat | `pnpm exec understand-anyway compat --plugin-root "$UA_PLUGIN_ROOT"` | 退出码 0 |
| versioned 部署 | repo-checkout runbook §3 ~ §8 | 全部退出码 0 |
| 浏览器 | `http://127.0.0.1:18666/` | mini-project 卡片可点击直达，不卡 loading |

## Pass criteria

本用例视作通过，当且仅当：

- 上表 6 行全部命中"预期"列；
- `node_modules/@understand-anyway/*/package.json` 中无 `workspace:*` 协议残留（`grep -r 'workspace:' node_modules/@understand-anyway/ | wc -l` 必须为 `0`）；
- repo-checkout runbook 的 Pass criteria 在 `pnpm exec understand-anyway` 路径下同样成立；
- Verdaccio storage 中 6 个包均出现本次 release script 目标版本且未触发任何 401/403。

任一条不满足即视为失败，回到 §3 重发包或回到 repo-checkout 修问题，不向上推进。
