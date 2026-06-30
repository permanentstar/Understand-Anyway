# 标准部署形态目录树（repo-checkout 单项目）

以 `UA_PROJECTS_ROOT=${UA_REPO_ROOT}/.tmp/understand-projects` 为例。

```
<UA_PROJECTS_ROOT>/
├── gateway/
│   ├── config/
│   │   ├── projects.json                          # 项目元数据
│   │   └── deploy.yaml                            # 部署/profile/provider 配置
│   ├── registry.json                              # 运行态注册（gateway 读）
│   ├── portal-assets/
│   │   └── icons/<projectId>.<ext>
│   ├── operations/
│   │   ├── nightly-latest.json
│   │   ├── nightly-runs/<ts>/result.json
│   │   └── daily-runs/<ts>/daily-update.log
│   └── runtime/
│       ├── state.json                             # gateway 版本指针
│       ├── audit.ndjson
│       ├── current  → releases/<gatewayVid>       # 软链
│       ├── stable   → releases/<gatewayVid>       # 软链（可选）
│       └── releases/<gatewayVid>/
│           ├── dist/                              # gateway 构建产物
│           └── manifest.json
├── src/                                           # 用户源码（与状态隔离）
│   └── mini-project/
│       ├── package.json
│       └── src/...
└── projects/
    └── mini-project/                              # 项目 state root
        ├── versioned-state.json                   # 版本指针
        ├── current  → versions/<vid>              # 软链
        ├── stable   → versions/<vid>              # 软链
        ├── source-mirror/
        │   └── <vid>/...                          # 源码快照（dereference 拷贝）
        └── versions/
            └── <vid>/                             # 版本目录（vid = YYYYMMDDhhmmss）
                ├── .understand-anything/
                │   ├── knowledge-graph.json
                │   ├── meta.json
                │   ├── config.json
                │   ├── intermediate/
                │   ├── nightly-latest.json
                │   └── nightly-runs/<ts>/result.json
                └── dashboard-dist/
                    ├── index.html
                    └── assets/
```

## 关键不变量

- `current` 软链必须存在，且指向 `versions/<vid>` 目录。
- `versioned-state.json.currentVersion` 必须与 `current` 软链目标一致。
- `versions/<vid>/manifest.json` 中 `current`/`stable` 标记必须与 `versioned-state.json` 对齐。
- `registry.json` 中：
  - `stateRoot` = `<UA_PROJECTS_ROOT>/projects/mini-project`
  - `prodDistDir` = `<UA_PROJECTS_ROOT>/projects/mini-project/versions/<vid>/dashboard-dist`（或解析 `current` 软链得到）
  - `publicPath` = `/project/mini-project/`
- `source-mirror/<vid>/` 必须是 dereference 拷贝（不依赖原仓库 git/checkout 状态）。
- 不允许出现：
  - 扁平 `<UA_PROJECTS_ROOT>/mini-project/.understand-anything/`
  - 扁平 `<UA_PROJECTS_ROOT>/mini-project/dashboard-dist/`
  - `<UA_PROJECTS_ROOT>/mini-project/` 直接作为源码目录
  - 跨项目共享 `dashboard-dist/`

## 检查命令

```bash
ROOT="${UA_PROJECTS_ROOT:-$HOME/understand-projects}"
STATE="$ROOT/projects/mini-project"
test -L "$STATE/current"                                                    # current symlink
test -f "$STATE/versioned-state.json"                                       # version state
VID=$(readlink "$STATE/current" | xargs -I{} basename {})
test -f "$STATE/versions/$VID/.understand-anything/knowledge-graph.json"
test -f "$STATE/versions/$VID/dashboard-dist/index.html"
test -d "$STATE/source-mirror/$VID"
test -f "$ROOT/gateway/config/projects.json"
test -f "$ROOT/gateway/registry.json"
node -e 'const r=require(`'"$ROOT"'/gateway/registry.json`);const p=r.projects["mini-project"];if(!p.prodDistDir.includes("versions/")) throw new Error("registry not pointing to versions/");'
```

所有命令退出码为 0 即视为目录布局合规。
