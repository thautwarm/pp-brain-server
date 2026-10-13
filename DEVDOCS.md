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

全仓库 6 个配置文件。每加一个之前，先问"它买到了什么"：

| 文件 | 买到什么 | 能不能不要 |
| --- | --- | --- |
| `package.json`（根） | 6 个脚本 + `packageManager` 版本声明 | 不能 |
| `pnpm-workspace.yaml` | 工作区 glob。**pnpm 不读 `package.json` 的 `workspaces` 字段**，只能写这里 | 不能（选 npm 就没这个文件） |
| `tsconfig.json` | 类型检查。**Node 只剥离类型，永远不检查类型**，没有它就等于放弃类型安全 | 不能 |
| `biome.jsonc` | lint + format | 能，但 lint 抓到过真问题（`require-await` 那次） |
| `packages/*/package.json` | 包名 + `exports` | 不能，workspaces 的硬要求 |
| `pnpm-lock.yaml` | 依赖锁定 | 不能 |

省文件的正确手段是**合并**，不是省略：

- 一份根 `tsconfig.json` 覆盖 `packages/*/src`，**不要**每包一份
- 不用 project references、不用 `composite` —— 那些是给"要产出 `dist/`"的场景准备的，这里没有产物要串联
- **绝对不要**为"和别的项目保持一致"引入 turbo / catalog / 分层 tsconfig。只有 3 个 devDependency 的仓库，版本集中管理（catalog）本身也是负担

## 约定

### 加 / 删包

用项目命令，别手工建目录：

```
pnpm project new pkg <name>    创建 packages/<name>
pnpm project new app <name>    创建 apps/<name>
pnpm project del <name>        删除
pnpm project list              列出当前工作区
```

新包只有两个文件（`package.json` + `src/index.ts`），因为 `pnpm-workspace.yaml` 的 glob、`tsconfig.json` 的 `include`、`test` 脚本的 glob 全是通配的，自动认领。建完记得 `pnpm install`。

**不在 `packages/` 或 `apps/` 下建新顶层目录**时，仍要手工改三处：`pnpm-workspace.yaml` 的 `packages`、`tsconfig.json` 的 `include`、`package.json` 的 `test` 脚本里的 glob（见坑 3）。命令不会替你改这些。

### 包之间互相引用

用包名，不用相对路径：

```ts
import { ChatAgent } from "@might/chat-core";
```

Node 会把 `node_modules` 里的软链解析回真实路径（`packages/chat-core/src/index.ts`），真实路径不在 `node_modules` 下，所以类型剥离照样生效。这是"零构建"能成立的关键。

pnpm 下的实际链路（实测成立）：

```
packages/消费方/node_modules/@might/chat-core -> ../../../chat-core
```

注意 pnpm **不会**在根 `node_modules` 建 `@might/`。所以在根目录下的裸文件里 `import "@might/chat-core"` 是解析不到的——这不是 bug，是 pnpm 在拦幽灵依赖。要引就老老实实建一个包、在它 `package.json` 里写 `"workspace:*"`。

### 导入必须写 `.ts` 后缀

```ts
import { x } from "./chunk.ts"; // 对
import { x } from "./chunk"; // 错，Node ESM 要求显式后缀
import { x } from "./chunk.js"; // 错，Node 不会把 .js 映射回 .ts
```

`tsc` 默认不允许这种写法，靠 `allowImportingTsExtensions` 放行。

### 加依赖

改对应包的 `package.json`，然后 `pnpm install`。装之前先 `npm view <pkg> version` 看最新版。

工作区内部引用用 `"workspace:*"`，这是 pnpm 的协议写法。

## 坑（全部实测撞出来的，不是抄的）

### 1. `lib` 必须排掉 DOM

TypeScript 自带的 `lib.dom.d.ts` 里 `Transformer` 接口**少了 `cancel`**（落后于 Streams 规范），而且它**会盖住** `@types/node` 里正确的定义（`@types/node/stream/web.d.ts:55` 明明有）。结果：

```
TS2353: 'cancel' does not exist in type 'Transformer<...>'
```

`tsconfig.json` 里 `"lib": ["esnext"]` 就是为这个。服务端库本来也不该有 DOM 类型。

### 2. `erasableSyntaxOnly` 必须开

Node 只做类型剥离，碰不了 `enum`、`namespace`、构造函数参数属性 —— 这些语法有运行时语义，剥离不掉。开了这个选项，它们会在 `pnpm check` 时就报错，而不是等到运行时才炸。

### 3. `node --test` 会扫全仓库并执行里面的测试文件

**这条有安全含义。** 裸跑 `node --test` 会递归扫描整个仓库，只要文件名匹配测试模式就**执行它** —— 包括从外部解压进来的 `tmp/` 里的代码。实测把 `tmp/core/test/injected.test.ts` 放进去，`node --test` 直接跑起来了。

`tsc`（靠 `include`）和 `biome`（靠 .gitignore）都不会，**只有 test 会**。所以脚本显式限定了 glob：

```
node --test "packages/**/*.test.ts" "apps/**/*.test.ts"
```

加新目录时忘了同步这行，新目录下的测试会静默不被跑到。

### 4. biome 的两个坑

- **默认缩进是 tab。** 零配置的 biome 会把整个仓库改成 tab，所以 `biome.jsonc` 里显式写了 `indentStyle: space`。
- **排除只能靠配置文件。** `--vcs-use-ignore-file=true` 这个命令行参数**实测无效**，`tmp/` 照样被扫（29 个文件 vs 10 个）。只有写进 `biome.jsonc` 的 `vcs.useIgnoreFile` 才生效。这很关键 —— 不挡住的话，`pnpm lint:fix` 会去改写 `tmp/` 里那份外部解压进来的代码。
- 附带：`biome.json` **不支持注释**，要用 `biome.jsonc`。

### 5. pnpm 会把 `ci` 这个脚本名吃掉

`pnpm ci` 是 pnpm 的**内建命令**（别名 `clean-install` / `ic`），跑的是 `pnpm clean` + `pnpm install --frozen-lockfile`，**不会执行 `package.json` 里叫 `ci` 的脚本**。它 exit 0、输出看着正常，你只会发现"怎么什么都没检查"。

所以这个仓库的验证脚本叫 `verify`，不叫 `ci`。

加新脚本前先确认名字没被占用：

```
pnpm <script> --help     # 打出 Usage: pnpm / Version，说明被内建命令挡了
```

（`check` / `test` / `lint` / `fmt` / `verify` 都验过，没被占用。）

### 6. 换运行时要重新验，不要假设

同一份代码在不同运行时的类型系统下有不同表现，而且方向可以相反：

| | 症状 | 触发条件 |
| --- | --- | --- |
| Deno | `serde_v8 error: recursion limit exceeded`，**一行内部报错，没有任何类型信息** | 类型展开超过 128 层（`ToolSet` 索引签名 + 映射类型 + 深条件类型） |
| Node | `'cancel' does not exist` 等假错误 | 见坑 1 |

Deno 那次是靠**按顶层声明逐段截断、二分定位**找出来的（单文件检查不管用，照样崩）。换运行时之前先假设"结论会变"，全部重验一遍。

### 7. 删包时留下悬空的 `workspace:*` 会锁死整个仓库

pnpm 解析不到 workspace 依赖时，**不是只有那个包坏掉 —— 是仓库里所有 pnpm 命令全部拒绝运行**，包括 pre-run 的依赖检查。而 `pnpm project del` 本身也是个 pnpm 命令，所以一旦锁死，你连"用命令把引用清掉"都做不到，只能手工改 json。

`pnpm project del` 因此**默认拒绝**删除还被依赖的包，列出引用方让你先处理；加 `--force` 才删，并且会**连带把引用方的依赖行一起清掉**。

手工 `rm -rf` 删目录绕过了这层保护。所以：**删包一律走 `pnpm project del`。**
