# brains 交接

`apps/brains` 是一个 HTTP server，给手机端提供 Brain API（规格见 [brain-api.md](./brain-api.md)）。

**当前进度：HTTP 层（路由 + MessagePack + 鉴权）已完成并通过测试；brain 层（队列、转写、合成、history）
一行都还没写，`main.ts` 还是空壳。** 接手的人从这里开始。

```
$ pnpm verify          # 退出码 0：70 过 / 1 跳过（跳过的是需要 Docker 的容器转码用例）
```

---

## 1. 已经能用的部分

### 四个端点

刚好是一张 2×2：**谁（human / agent）× 方向（进 brain / 出 brain）**。
名字就是 `<from>-to-<to>`，机械推导，不用记。

| 端点 | 请求 | 响应 | 编码 |
| --- | --- | --- | --- |
| `POST /human-to-brain` | `{ brain_id, audio }`（Ogg Opus 16k） | `{ kind:"text", text }` | MessagePack |
| `POST /brain-to-human` | `{ brain_id }`，**长轮询** | `{ kind:"empty" }` 或 `{ kind:"text", text, audio }`（Ogg Opus 24k） | MessagePack |
| `POST /agent-to-brain` | `{ brain_id, text }` | `{ kind:"empty" }` | JSON / MessagePack |
| `POST /brain-to-agent` | `{ brain_id }`，**长轮询** | `{ kind:"empty" }` 或 `{ kind:"text", text }` | JSON / MessagePack |

**方向本身预告了 HTTP 语义**，这条不是巧合也不是约定，是从命名就能推出来的：
`*-to-brain` 是提交、立即返回；`brain-to-*` 是长轮询、可以空手而归。所以"哪个要等"不需要单独记。

四个端点的形状都由规格定死（[brain-api.md](./brain-api.md)）。带音频的 body **只能 MessagePack**
（音频是 bin）；agent 那对 JSON 和 MessagePack 都收，**响应跟着请求的编码走**。错误一律 `text/plain`。

### 文件

| 文件 | 职责 |
| --- | --- |
| [apps/brains/src/http.ts](../apps/brains/src/http.ts) | 路由、鉴权、请求校验（MessagePack / JSON 收发）、长轮询等待 |
| [apps/brains/src/http.test.ts](../apps/brains/src/http.test.ts) | 21 条用例，含真起 server 走 socket 的端到端 |
| [apps/brains/src/main.ts](../apps/brains/src/main.ts) | **还是空壳** |

依赖（已装好）：`hono`、`@hono/node-server`、`zod`、`@msgpack/msgpack`、`@ai-sdk/openai-compatible`、`@might/chat`、`@might/audio`。

### 接线契约：`BrainPorts`

路由只认这一个接口，**它不 import `@might/chat` / `@might/audio` 的任何东西**。四个方法名和四个端点
一一同名，接的时候不用对表（`http.ts` 顶部有每个方法的完整说明）：

| 端口方法 | 对应端点 |
| --- | --- |
| `humanToBrain({ brain_id, audio }, { signal })` | `human-to-brain` |
| `brainToHuman({ brain_id }, { signal })` | `brain-to-human` |
| `agentToBrain({ brain_id, text }, { signal })` | `agent-to-brain` |
| `brainToAgent({ brain_id }, { signal })` | `brain-to-agent` |

有两条约定**必须守住**，路由依赖它们：

1. **`humanToBrain` 只该等转写。** 进 history、跑模型、合成都该甩到后台——用户每说一句都要等到整轮
   生成完才拿到文本的话，这个接口就白设计了。
2. **两个长轮询方法在 `signal` 中止时返回 `{ kind: "empty" }`，不要抛。** 没内容是规格里最正常的一条
   路径，不是错误。（路由做了兜底：中止后就算你抛了也归一成 `empty`，但这属于"实现没守约定"，别依赖它。）

---

## 2. 还没做的：brain 层

### 先说一个推断（**需要你确认**）

`agent-to-brain` / `brain-to-agent` 是 **HTTP 端点**，而你不会给自己的内部 stage 开 HTTP 接口——
**所以 agent 是外部进程**。brain 不是"自己跑模型的大脑"，而是个有状态的中转站：

```
手机 ──human-to-brain──▶ brain ──brain-to-agent──▶ agent（外部，爱是什么是什么）
手机 ◀──brain-to-human── brain ◀──agent-to-brain── agent
```

如果这个推断错了（比如 agent 就该跑在 brain 里，那两个端点其实是别的用途），下面这节要重写。

### 已对齐的队列设计

每个 brain 四个队列 + 一份 history，**全内存**（服务端重启会丢，`ChatAgent.codec` 已在，以后要落盘
是加一个模块的事）：

```
[人类 audio]             ← human-to-brain 压入 ──STT──▶ [给 agent 的文本] ─▶ brain-to-agent 弹出
[agent 文本] ──TTS──▶ [agent 音频]    ← agent-to-brain 压入            ─▶ brain-to-human 配对弹出
```

```ts
history: (
  | { kind: "human-audio"; bytes: Uint8Array }   // 人类音频，留作以后多模态，不喂纯文本模型
  | { kind: "human-text";  text: string }        // 人类音频转录
  | { kind: "agent-text";  message: ApplicationMessage }  // agent 文本，连 metadata 一起留
)[]
```

`history` 是**事件日志**（收到音频追加一条、转写出来再追加一条），投影到模型时只取 `human-text`
（→ user 消息）和 `agent-text`（→ assistant 消息）。

### 还要写的东西

- `brain.ts` —— 队列 + history + 串行 pump。**建议把能力做成注入**（`transcribe` / `synthesize` 两个函数），
  这样测试完全绕开 ffmpeg 和 provider——现在 `http.test.ts` 就是这么干的，很好用。
- `models.ts` —— 唯一碰 provider 的文件。STT/TTS 走 `@ai-sdk/openai-compatible`
  （见 [resource.md](../tmp/resource.md) 的 baseURL），对话模型走 `@might/chat` 的 `deepseek.prepare`。
- `config.ts` —— 环境变量 + 启动期断言（见 §3 第一条）。
- `main.ts` —— 把上面串起来 + `listen`。

---

## 3. 三个会咬人的地方（都实测过）

1. **转码的默认 runner 认不出 WAV，而 MOSS-TTS 返回的正是 WAV。**
   下行要 `AudioHelper.convertToOggOpus(wav, undefined, { sampleRate: 24000 })`，但默认走的 `wasm`
   只认 WebM 和 Ogg Opus，WAV 会被判成"这条路做不了"，兜底去走 `build`——**需要 Docker**。

   > 注意别把原因说反了：不是 WAV 在 WASM 里转不了。是
   > [wasm-runner.ts](../packages/audio/src/implementation/wasm-runner.ts) 只引了两个 demuxer、
   > `sniff()` 也只认那两个容器的魔数，别的格式一律落到 `undefined` 那一支。

   **这条能直接消掉。** WAV 是 RIFF 头 + 未压缩 PCM，解码它不需要任何编解码器——一个 RIFF 解析器
   把采样取出来，喂给现成的 `encodeOpus` 就行（`wasm-runner` 里已经在用 `sampleRate: pcm.sampleRate`
   建编码器）。那个文件顶部写着"以后要 vendor 就换这一个文件"，本来就是设计成可替换的。
   补上之后部署不用装 ffmpeg，启动断言也能从"必须 container 或 http"放宽成 `wasm | container | http`。

   （上行不用转码：客户端本来就是 Ogg Opus，直接喂 STT。）

2. **`server.close()` 会被 undici 的 keep-alive 连接挂住**，测试直接卡死。先
   `closeAllConnections()` 再 `close()`。

3. **错误响应不能长得像成功响应。** 客户端按端点的 Content-Type 分派，错误体要是长成
   `application/msgpack` 或 `application/json`，就会被当成一条合法回复去解包。一律 `text/plain`。
   有一条测试专门卡着这个。

---

## 4. 待决定

- **`packages/might-center` 从磁盘上没了**，git 里是 `D` 状态，不确定是谁删的。
  已确认没人引用它（全仓库 grep 无命中，lockfile 里也干净），所以不影响构建。
- **`packages/chat/src/v1/abstraction/README.md:21` 还是旧包名**：
  `import { ChatAgent } from "@might/chat-core"` 该改成 `@might/chat`。
  改成之后这个 import 才真正成立——根入口的 re-export 是这次刚补上的，在那之前 `@might/chat`
  只导出 `Credential` / `ModelAuth` 两个类型。

## 5. 仓库约定（不熟这个仓库的话，这几条最先撞）

- Node 24 原生跑 `.ts`，**零构建**。相对导入必须写 `.ts` 后缀。
- `erasableSyntaxOnly`：`enum` / `namespace` / 构造函数参数属性一律不能用。
- `noUncheckedIndexedAccess`：所以环境变量一律 `process.env["MIGHT_X"]` 方括号访问。
- 测试只用 `node:test` 的 `test`（**没有 describe/it**）+ `node:assert/strict`，和源码同目录。
- `pnpm lint:fix` 是**全仓库**的，会顺手重排你没在改的文件。介意的话跑之前先 commit。
- 改这个仓库之前先读 [DEVDOCS.md](../DEVDOCS.md)。

## 6. 怎么验

```bash
pnpm verify                              # check + lint + test
node apps/brains/src/main.ts             # 空配置下应带清晰报错退出
```

端到端要真实配置（chat 的 baseURL/key、STT `192.0.2.113:8082`、TTS `192.0.2.102:6677`）。

带音频的两个端点 body 是 MessagePack，`curl -d` / `-F` 产不出来——先用任意 msgpack 编码器把
body 写成文件，再 `--data-binary`：

```bash
curl -sS -X POST localhost:8787/brain-to-human \
  -H 'content-type: application/msgpack' \
  --data-binary @request.msgpack -i       # request.msgpack = MessagePack 的 {"brain_id":"员工3"}
```

agent 那两个端点是纯文本，直接 JSON 就行（响应也跟着是 JSON）：

```bash
curl -sS -X POST localhost:8787/brain-to-agent \
  -H 'content-type: application/json' -d '{"brain_id":"员工3"}' -i
```
