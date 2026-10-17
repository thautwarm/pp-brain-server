# might

Agent 开发的 TypeScript monorepo。**Node 24 原生跑 TypeScript**，零构建、零 JS 产物。

```
package.json            脚本 + packageManager 版本声明
pnpm-workspace.yaml     工作区 glob（pnpm 不读 package.json 的 workspaces 字段）
tsconfig.json           全仓库唯一一份，只服务 `tsc --noEmit`
biome.jsonc             lint + format
Dockerfile.brains       brains 的镜像（零构建，Node 直接跑 .ts）
docker-compose.yaml     起 brains（宿主端口 → 容器 8787）
packages/chat/          @might/chat —— 会话的事实层（UIMessage / ChatAgent）+ 凭据→模型的 adapter
packages/audio/         @might/audio —— 语音的事实层（合成 / 转写 / 转成 Ogg Opus）
apps/brains/            Brain API 的服务端
docs/                   brain-api-spec.md（接口契约）、client-notes.md（手机端）、brains.md（服务端）
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
| `pnpm project`  | 建包 / 删包 / 列工作区（`--help` 看用法） |

**验证脚本叫 `verify` 不叫 `ci`** —— `pnpm ci` 是 pnpm 的内建命令（清空重装），会把同名脚本吃掉且不报错。详见 [DEVDOCS.md](DEVDOCS.md)。

跑单个文件：`node packages/audio/src/index.ts` —— 没有编译等待。

## 改这个仓库之前

**先读 [DEVDOCS.md](DEVDOCS.md)。** 里面写了为什么这么搭、加新包要动哪几个地方，以及 7 个实测撞出来的坑。
