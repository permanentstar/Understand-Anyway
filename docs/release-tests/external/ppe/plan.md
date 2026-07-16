# external / ppe

## 目标

把 PPE 验证从临时操作收成固定 case，供 `release:gate` 按需调用。

## case

- `ppe-repo`
- `ppe-npm-installed`
- `ppe-ops`
- `ppe-real-llm`

## 说明

这些 case 默认不跑；只有本次发版明确要求时才执行。
