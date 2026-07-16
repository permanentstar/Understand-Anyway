# local / ops-versioning / runbook

> 正常发版前不手工逐条敲命令，直接跑：
>
> ```bash
> pnpm run release:gate
> ```
>
> 本文只在 `node scripts/release-gate-ops.mjs` 失败后用于排查。

## 入口

```bash
export UA_PLUGIN_ROOT="/path/to/understand-anything-plugin"
node scripts/release-gate-ops.mjs
```

## 失败排查顺序

1. 先看 `compat`
2. 再看 `dashboard build-dist`
3. 再看 `project-state` 指针翻转
4. 再看 `gateway` runtime release 指针翻转
5. 最后看 `serve / notify / repair`
