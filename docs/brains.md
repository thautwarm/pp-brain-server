# brains

`apps/brains` —— Brain API 的服务端（接口契约见 [brain-api-spec.md](./brain-api-spec.md)）。
它自己不跑模型：转写、合成、对话都打外部端点，地址由 `.env` 给。

## 跑起来

```bash
cp config.toml.example config.toml   # 这台机器认哪些 brain，键就是客户端手输的名字
                                     # .env 自己写一份，内容见下面「配置」
docker compose up -d --build
docker compose logs -f brains
```

也可以不起容器，直接：

```bash
node --env-file=.env apps/brains/src/main.ts
```

宿主机端口见 `docker-compose.yaml`（现在是 `18781` → 容器 `8787`）。容器名 `might-brains-1`。

启动时把配置**一次断言完**：缺 `STT_API_BASE_URL` / `TTS_API_BASE_URL` / `MIGHT_CHAT_API_KEY` /
`MIGHT_CHAT_API_BASE_URL`，或者读不了 `config.toml`，都指名报错并退出 —— 不会起来一个半死的服务。

## 配置

| 变量 | 用途 |
| --- | --- |
| `STT_API_KEY` / `STT_API_BASE_URL` | 转写端点（OpenAI 兼容，baseURL 底下拼 `/audio/transcriptions`） |
| `TTS_API_KEY` / `TTS_API_BASE_URL` | 合成端点（同上，拼 `/audio/speech`） |
| `MIGHT_CHAT_API_KEY` / `MIGHT_CHAT_API_BASE_URL` | 修订/摘要用的对话端点 |
| `MIGHT_CHAT_MODEL` | 修订用的模型名 |
| `MIGHT_BRAINS_TOKEN` | 路由鉴权；空 = 不启用 |
| `MIGHT_BRAINS_PORT` | 监听端口，默认 8787 |
| `MIGHT_BRAINS_POLL_TIMEOUT_MS` | 两个长轮询的上限，默认 25000 |
| `MIGHT_BRAINS_CONFIG` | 配置表路径，默认 `config.toml` |

`.env` 与 `config.toml` 都不入库（见 `.gitignore`），也不烘进镜像（见 `.dockerignore`）——
里面的端点和 brain 名是本机的事。

## 文件

| 文件 | 职责 |
| --- | --- |
| [src/http.ts](../apps/brains/src/http.ts) | 路由、鉴权、请求校验、长轮询；`BrainPorts` 契约也在这里 |
| [src/brain-center.ts](../apps/brains/src/brain-center.ts) | `BrainPorts` 的实现：队列、history、后台任务、队列日志 |
| [src/revise.ts](../apps/brains/src/revise.ts) | 修订：让外部模型检查最近的转录，必要时给 agent 告警；顺带压缩 history |
| [src/stt-tts.ts](../apps/brains/src/stt-tts.ts) | STT/TTS 的薄封装（模型工厂 + 重试 + Ogg 兜底） |
| [src/format.ts](../apps/brains/src/format.ts) | 进 prompt 的标签、语音禁用标记、语种判据 |
| [src/config.ts](../apps/brains/src/config.ts) | 读并校验配置表 |
| [src/main.ts](../apps/brains/src/main.ts) | 接线：断言配置、注册 brain、起路由、起后台任务、SIGTERM |

## 运行时模型

**全内存。** 每个 brain 的 history 与队列都在 `brainsStore` 里，进程重启即清零
（`ChatAgent.codec` 已经能序列化会话，要落盘是加一个模块的事）。

后台一个 35 ms 一跳的循环（`startBackgroundTask`）管两件事：

1. **合成**：`inbounds.agent` 里的文本逐条送去 TTS，成品进 `outbounds.human` 等人类取走。
   全局并发上限 10。取一条就出队；失败只记日志，不重投。
2. **修订**：见下。

### 队列

| 队列 | 谁压入 | 谁弹出 | 上限 |
| --- | --- | --- | --- |
| `outbounds.agent` | 转写结果、修订告警 | `POST /brain-to-agent` | 64 |
| `inbounds.agent` | `POST /agent-to-brain` | 后台的 TTS | 64 |
| `outbounds.human` | TTS 成品 | `POST /brain-to-human` | 12 |

满了丢**最旧**的一条。投递语义（读即消费、无重投、单消费者）见规格 §7。

### 修订

`dirty` 计数：`human-to-brain` 与 `agent-to-brain` 各 +1，攒够 3 触发一轮。一轮里：

- 把 history 投影成对话上下文（`toChatContext`），交给外部对话模型，让它用 `notify` 工具提告警。
- **音频只带尾部最多 7 条**（`audioTailIndices`）：每条 base64 几十 KB，而 prompt 问的是"最近的
  转录准不准"。更早的仍以转录文字留在上下文里。
- 模型要了告警就包成 `<asr-warning>` 压进 `outbounds.agent`。
- 这一轮用的 token 超过 10240 就顺手压缩 history（`maybeCompression`），摘要存 `brain.historySummary`。

### 语音

- 合成前先过 `Format.forTts`：`<!-- disable voice -->` 段不念（文本照旧保留）。
- `Format.ttsLanguage`：全 ASCII 的文本按 `en` 合成，否则用服务端默认。
- 请求 `outputFormat: "opus"`；回来的不是 Ogg 才本地转（**镜像里没有 ffmpeg**，理由见
  [Dockerfile.brains](../Dockerfile.brains) —— 实测 TTS 认 `response_format=opus`，正常不会走到那一步）。

### 日志

`docker compose logs -f brains`：

- `[agent] +1 <brain> <asr|warning> q=a→b "<前 60 字>"` —— 入队；撞上限时同一行带 `DROPPED-OLDEST`。
- `[agent] -1 <brain> q=a→b "<前 60 字>"` —— 出队；客户端已断开时带 `ABORTED(…这条丢了)`。
- `[tts] <brain> 整段都被静音了，跳过合成 "…"`。

对账方式：**push 条数 = 出队条数 + 队里剩的条数**，对不上就是撞了上面两条之一。

## 会咬人的地方

1. **容器里 `node` 是 PID 1**，内核不对 PID 1 施加"默认动作"信号。`main.ts` 里那个 SIGTERM
   handler 不是装饰 —— 删了它，`docker compose stop` 会等满 10 秒 grace 再 SIGKILL（退出码 137）。
2. **`server.close()` 会被 undici 的 keep-alive 连接挂住**，测试直接卡死。先
   `closeAllConnections()` 再 `close()`。
3. **错误响应不能长得像成功响应**：客户端按端点分派 Content-Type，错误体长成
   `application/msgpack` / `application/json` 就会被当成合法回复。一律 `text/plain`。
   没有这个 brain 是 `404`，不是 `502`。
4. **provider 不是 model。** `createOpenAICompatible(...)` / `createOpenAI(...)` 返回的是 provider，
   它跟 model 都有 `specificationVersion`，不给 AI SDK 一个真正的 model，它会死在
   `resolvedModel.provider.split(".")` 上（`TypeError: Cannot read properties of undefined`）。
5. **`@ai-sdk/openai-compatible` 的音频白名单只有 wav / mp3**（上游 3.0.69 仍如此），喂 Ogg Opus 会抛
   `UnsupportedFunctionalityError`。绕法见 [packages/chat/.../openai-compatible-ogg.ts](../packages/chat/src/v1/adapter/openai-compatible-ogg.ts)。
6. **TOML 的裸键只认 `A-Za-z0-9_-`**：中文 `brain_id` 必须写成 `["员工3"]`，否则报
   `illegal character in key` 且不带行号。

## 验证

```bash
pnpm verify                      # check + lint + test
node apps/brains/src/main.ts     # 空配置下应带清晰报错退出
```

端到端（要真实 `.env`）；`<brain>` 换成你 `config.toml` 里的名字：

```bash
# agent 那两个直接 JSON
curl -sS -X POST localhost:18781/brain-to-agent \
  -H 'content-type: application/json' -d '{"brain_id":"<brain>"}'

# 带音频的那两个只能 MessagePack：body 得先编好
curl -sS -X POST localhost:18781/brain-to-human \
  -H 'content-type: application/msgpack' --data-binary @request.msgpack -i
```

`curl -d` / `-F` 产不出 msgpack —— 用任意 msgpack 编码器把 `{"brain_id":"<brain>"}` 写成文件再
`--data-binary`。

## 已知的短板

- **修订的 `content` 可能是空的。** 现在这个对话模型把内容放在 `reasoning_content` 里，而 AI SDK 只取
  `content`。对告警没影响（告警走 tool call），但**压缩出来的摘要会是空字符串**。
  要治：让 provider 把 `reasoning_content` 映射出来，或把压缩那一路的 `level` 设成 `off`。
- **队列的日志一直开着。** 量不大，但生产上如果嫌吵，`brain-center.ts` 里那几处 `console.log` /
  `console.warn` 就是全部。
- **状态全内存。** 重启即清零，也没有多实例的一致性。

## 待决定

- 上行要 Ogg 封装需要 `MUXER_OUTPUT_OGG`（API 29+），客户端当前 `minSdk` 是 24 —— 见
  [client-notes.md](./client-notes.md)。
