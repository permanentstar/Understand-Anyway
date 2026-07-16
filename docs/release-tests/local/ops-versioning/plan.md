# local / ops-versioning

## 目标

补齐发版前本地常规运维命令矩阵，避免只验证“能部署”，却没验证“日常运维命令还能用”。

## 覆盖范围

- `dashboard build-dist / start / stop / status`
- `gateway publish / set-stable / rollback / list / gc`
- `project-state publish / set-stable / rollback / list / gc`
- `compat`
- `review-graph-health`
- `notify nightly`
- `serve --project`
- `repair llm-failures / llm-graph-failures`

## 入口

```bash
node scripts/release-gate-ops.mjs
```

## 验收

命令全部退出码 `0`，并且：

1. `dashboard` 生命周期命令能起停并正确回报状态
2. `gateway` 与 `project-state` 的 current/stable 指针翻转正确
3. `serve --project` 的健康路径能返回 `knowledge-graph.json`
4. `notify nightly` 能写出一条本地通知文件
