# DEVDOCS

这个仓库怎么搭的、为什么这么搭、以及改它之前你必须知道的坑。

## 核心原则

**`tsc` 在这个仓库里只是个检查器，不产出任何东西。**

跑代码是 Node 自己的事（原生类型剥离），`tsc --noEmit` 只负责"看"。这一条推导出后面所有决定：没有构建步骤、没有 `dist/`、没有 `outDir`、没有 project references、`exports` 直接指向 `.ts` 源码。

```
需求          谁来做                    要写什么配置
────────────────────────────────────────────────────
跑 .ts        Node 24 类型剥离          不用写
类型检查       tsc --noEmit             tsconfig.json ×1（全仓库一份）
测试          node --test              不用写
lint + format biome                    biome.jsonc ×1
```

## 配置文件的账

全仓库 5 个配置文件。每加一个之前，先问"它买到了什么"：

| 文件 | 买到什么 | 能不能不要 |
| --- | --- | --- |
| `package.json`（根） | workspaces + 4 个脚本 | 不能 |
| `tsconfig.json` | 类型检查。**Node 只剥离类型，永远不检查类型**，没有它就等于放弃类型安全 | 不能 |
| `biome.jsonc` | lint + format | 能，但 lint 抓到过真问题（`require-await` 那次） |
| `packages/*/package.json` | 包名 + `exports` | 不能，npm workspaces 的硬要求 |
| `package-lock.json` | 依赖锁定 | 不能 |

省文件的正确手段是**合并**，不是省略：

- 一份根 `tsconfig.json` 覆盖 `packages/*/src`，**不要**每包一份
- 不用 project references、不用 `composite` —— 那些是给"要产出 `dist/`"的场景准备的，这里没有产物要串联
- **绝对不要**为"和别的项目保持一致"引入 turbo / pnpm catalog / 分层 tsconfig

## 约定

### 加一个新包

1. 建目录，放一个 `package.json`，必须有 `name` 和 `exports`
2. 根 `package.json` 的 `workspaces` glob 自动认领，不用改根配置
3. 如果新目录不在 `packages/` 或 `apps/` 下，要**同时**改三处：
   - 根 `package.json` 的 `workspaces`
   - `tsconfig.json` 的 `include`
   - `package.json` 的 `test` 脚本里的 glob（见坑 5）

### 包之间互相引用

用包名，不用相对路径：

```ts
import { ChatAgent } from "@might/chat-core";
```

Node 会把 `node_modules` 里的软链解析回真实路径（`packages/chat-core/src/index.ts`），真实路径不在 `node_modules` 下，所以类型剥离照样生效。这是"零构建"能成立的关键。

### 导入必须写 `.ts` 后缀

```ts
import { x } from "./chunk.ts"; // 对
import { x } from "./chunk"; // 错，Node ESM 要求显式后缀
import { x } from "./chunk.js"; // 错，Node 不会把 .js 映射回 .ts
```

`tsc` 默认不允许这种写法，靠 `allowImportingTsExtensions` 放行。

### 加依赖

改对应包的 `package.json`，然后 `npm install`。装之前先 `npm view <pkg> version` 看最新版。

## 坑（全部实测撞出来的，不是抄的）

### 1. `lib` 必须排掉 DOM

TypeScript 自带的 `lib.dom.d.ts` 里 `Transformer` 接口**少了 `cancel`**（落后于 Streams 规范），而且它**会盖住** `@types/node` 里正确的定义（`@types/node/stream/web.d.ts:55` 明明有）。结果：

```
TS2353: 'cancel' does not exist in type 'Transformer<...>'
```

`tsconfig.json` 里 `"lib": ["esnext"]` 就是为这个。服务端库本来也不该有 DOM 类型。

### 2. `erasableSyntaxOnly` 必须开

Node 只做类型剥离，碰不了 `enum`、`namespace`、构造函数参数属性 —— 这些语法有运行时语义，剥离不掉。开了这个选项，它们会在 `npm run check` 时就报错，而不是等到运行时才炸。

### 3. `node --test` 会扫全仓库并执行里面的测试文件

**这条有安全含义。** 裸跑 `node --test` 会递归扫描整个仓库，只要文件名匹配测试模式就**执行它** —— 包括从外部解压进来的 `tmp/` 里的代码。实测把 `tmp/core/test/injected.test.ts` 放进去，`node --test` 直接跑起来了。

`tsc`（靠 `include`）和 `biome`（靠 .gitignore）都不会，**只有 test 会**。所以脚本显式限定了 glob：

```
node --test "packages/**/*.test.ts" "apps/**/*.test.ts"
```

加新目录时忘了同步这行，新目录下的测试会静默不被跑到。

### 4. biome 的两个坑

- **默认缩进是 tab。** 零配置的 biome 会把整个仓库改成 tab，所以 `biome.jsonc` 里显式写了 `indentStyle: space`。
- **排除只能靠配置文件。** `--vcs-use-ignore-file=true` 这个命令行参数**实测无效**，`tmp/` 照样被扫（29 个文件 vs 10 个）。只有写进 `biome.jsonc` 的 `vcs.useIgnoreFile` 才生效。这很关键 —— 不挡住的话，`npm run lint:fix` 会去改写 `tmp/` 里那份外部解压进来的代码。
- 附带：`biome.json` **不支持注释**，要用 `biome.jsonc`。

### 5. 换运行时要重新验，不要假设

同一份代码在不同运行时的类型系统下有不同表现，而且方向可以相反：

| | 症状 | 触发条件 |
| --- | --- | --- |
| Deno | `serde_v8 error: recursion limit exceeded`，**一行内部报错，没有任何类型信息** | 类型展开超过 128 层（`ToolSet` 索引签名 + 映射类型 + 深条件类型） |
| Node | `'cancel' does not exist` 等假错误 | 见坑 1 |

Deno 那次是靠**按顶层声明逐段截断、二分定位**找出来的（单文件检查不管用，照样崩）。换运行时之前先假设"结论会变"，全部重验一遍。

## 代码来源

`packages/chat-core/` 从 `@correct-ai/core@7.1.2` 迁入本仓库，`LICENSE`（MIT，Copyright (c) 2026 thautwarm）随包保留。

迁移时的改动，仅此三项：

1. 包名 `@correct-ai/core` → `@might/chat-core`
2. 相对导入 `./x.js` → `./x.ts`（Node ESM 要求显式后缀）
3. 格式化工具从 prettier 换成 biome

**业务代码一行没动。** 在 Deno 下必须改写的那处类型（`InferToolInput<TOOLS[NAME]>` → `InferUITools<TOOLS>[NAME]["input"]`，为绕开坑 5）在 Node 下原样就能过，已改回原写法。
