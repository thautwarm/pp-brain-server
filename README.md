# might

Agent 开发的 TypeScript monorepo。**Node 24 原生跑 TypeScript**，零构建、零 JS 产物。

```
package.json          脚本 + packageManager 版本声明
pnpm-workspace.yaml   工作区 glob（pnpm 不读 package.json 的 workspaces 字段）
tsconfig.json         全仓库唯一一份，只服务 `tsc --noEmit`
biome.jsonc           lint + format
packages/chat-core/   @might/chat-core —— 模型会话的事实层（UIMessage / ChatAgent）
docs/                 调研文档
```

`exports` 直接指向 `./src/index.ts`，Node 运行时自己剥掉类型。没有构建步骤，没有 `dist/`。

## 命令

| 命令            | 作用                                 |
| --------------- | ------------------------------------ |
| `pnpm install`  | 装依赖                               |
| `pnpm check`    | `tsc --noEmit` 类型检查（全仓库一次） |
| `pnpm test`     | `node --test`                        |
| `pnpm lint`     | biome 检查                           |
| `pnpm lint:fix` | biome 自动修                         |
| `pnpm verify`   | 上面三个串起来                       |

**验证脚本叫 `verify` 不叫 `ci`** —— `pnpm ci` 是 pnpm 的内建命令（清空重装），会把同名脚本吃掉且不报错。详见 [DEVDOCS.md](DEVDOCS.md)。

跑单个文件：`node packages/chat-core/src/index.ts` —— 没有编译等待。

## 改这个仓库之前

**先读 [DEVDOCS.md](DEVDOCS.md)。** 里面写了为什么这么搭、加新包要动哪几个地方，以及 6 个实测撞出来的坑。
