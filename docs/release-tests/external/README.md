# external / README

外部环境套件不是默认必跑项，但一旦本次发版明确要求跑，就会升级为阻塞项。

统一入口：

```bash
source scripts/release-gate-ppe-env.sh
pnpm run release:gate -- --external <case>
```

第一批 case：

- `ppe-repo`
- `ppe-npm-installed`
- `ppe-ops`
- `ppe-real-llm`

说明：

- 本地门禁总是先跑
- 外部环境 case 只在显式请求时执行
- PPE 第一阶段默认实现为仓库内脚本 `scripts/release-gate-ppe.mjs`
- PPE 默认环境变量由 `scripts/release-gate-ppe-env.sh` 提供
- `release:gate` 外部 case 仍支持用环境变量覆盖实际执行命令
