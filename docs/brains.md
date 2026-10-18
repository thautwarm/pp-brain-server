# brains

`apps/brains` —— Brain API 的服务端（接口契约见 [brain-api-spec.md](./brain-api-spec.md)）。
它自己不跑模型：转写、合成、对话都打外部端点，地址由 `.env` 给。

## 跑起来

```bash
cp .env.example .env   # 端点、密钥、模型名；填完再起
docker compose up -d --build
docker compose logs -f brains
```

没有 brain 清单：`brain_id` 由客户端随便给，第一次出现时现建。

也可以不起容器，直接：

```bash
node --env-file=.env apps/brains/src/main.ts
```

宿主机端口见 `docker-compose.yaml`（现在是 `18781` → 容器 `8787`）。容器名 `might-brains-1`。

启动时把配置**一次断言完**：缺 `STT_API_BASE_URL` / `TTS_API_BASE_URL` / `MIGHT_CHAT_API_KEY` /
`MIGHT_CHAT_API_BASE_URL`，都指名报错并退出 —— 不会起来一个半死的服务。

## 配置

| 变量 | 用途 |
| --- | --- |
| `STT_API_BASE_URL` / `STT_API_KEY` / `STT_MODEL` | 转写端点（OpenAI 兼容，baseURL 底下拼 `/audio/transcriptions`）；`STT_MODEL` 不给则用 `qwen-asr` |
| `TTS_API_BASE_URL` / `TTS_API_KEY` | 合成端点，拼 `/audio/speech/stream`（流式 TTS，见下）；`TTS_MODEL` 不再使用，模型/音色由 daemon 决定 |
| `TTS_VOICE` | **必填**。默认音色，名字得是 daemon 认的（`default` = 不用参考音色）。填错不会启动失败，但每次合成都会 502（日志里有原因） |
| `MIGHT_CHAT_API_KEY` / `MIGHT_CHAT_API_BASE_URL` | 修订/摘要用的对话端点 |
| `MIGHT_CHAT_MODEL` | 修订用的模型名 |
| `MIGHT_BRAINS_TOKEN` | 路由鉴权；空 = 不启用 |
| `MIGHT_BRAINS_PORT` | 监听端口，默认 8787 |
| `MIGHT_BRAINS_POLL_TIMEOUT_MS` | 长轮询上限，默认 25000；`/brain-to-human` 只约束等到有内容 |

`.env` 不入库（见 `.gitignore`），也不烘进镜像（见 `.dockerignore`）——里面的端点和密钥是
本机的事。

## 文件

| 文件 | 职责 |
| --- | --- |
| [src/http.ts](../apps/brains/src/http.ts) | 路由、鉴权、请求校验、长轮询；`BrainPorts` 契约也在这里 |
| [src/brain-center.ts](../apps/brains/src/brain-center.ts) | `BrainPorts` 的实现：队列、history、逐块合成、日志 |
| [src/revise.ts](../apps/brains/src/revise.ts) | 修订：让外部模型检查最近的转录，必要时给 agent 告警；顺带压缩 history |
| [src/stt-tts.ts](../apps/brains/src/stt-tts.ts) | STT/TTS 的薄封装（模型工厂 + 重试 + Ogg 兜底） |
| [src/format.ts](../apps/brains/src/format.ts) | 进 prompt 的标签、语音禁用标记 |
| [src/main.ts](../apps/brains/src/main.ts) | 接线：断言配置、起路由、起后台任务、SIGTERM |

## 运行时模型

**全内存。** 每个 brain 的 history 与队列都在 `brainsStore` 里，进程重启即清零
（`ChatAgent.codec` 已经能序列化会话，要落盘是加一个模块的事）。

`brain_id` 是客户端随便给的，**第一次出现时现建**，**空闲 2 小时后由后台循环卸载**（不然
一串随机名字就能把内存吃光）。所以拼错名字不会报错，只会开一段新对话。

后台一个 35 ms 一跳的循环（`startBackgroundTask`）管两件事：

1. **修订**：见下。
2. **空闲淘汰**：10 秒扫一次，把 2 小时没交互的 brain 卸掉。

**合成不在后台跑**：`/brain-to-human` 这个请求自己逐块合成、边合边吐；没人轮询就不合成。

### 队列

| 队列 | 谁压入 | 谁弹出 | 上限 |
| --- | --- | --- | --- |
| `outbounds.agent` | 转写结果、修订告警 | `POST /brain-to-agent` | 64 |
| `inbounds.agent` | `POST /agent-to-brain` | `POST /brain-to-human`（逐块合成） | 64 |

满了丢**最旧**的一条。投递语义（读即消费、无重投、单消费者）见规格 §7。

### 修订

`dirty` 计数：`human-to-brain` 与 `agent-to-brain` 各 +1，攒够 3 触发一轮。一轮里：

- 把 history 投影成对话上下文（`toChatContext`），交给外部对话模型，让它用 `notify` 工具提告警。
- **音频只带尾部最多 7 条**（`audioTailIndices`）：每条 base64 几十 KB，而 prompt 问的是"最近的
  转录准不准"。更早的仍以转录文字留在上下文里。
- 模型要了告警就包成 `<asr-warning>` 压进 `outbounds.agent`。
- 这一轮用的 token 超过 10240 就顺手压缩 history（`maybeCompression`），摘要存 `brain.historySummary`。

### 语音

- 音色解析：队列项自带的（入队时快照）→ 否则 `process.env.TTS_VOICE`；两者都没有就**跳过合成并告警**
  （不能“不传”：语音 SDK 会自己塞 `alloy`）。
- `/brain-to-human` 不排队等整段：`forTts` 过一遍，把整条文本交给流式 TTS
  （`POST /audio/speech/stream`，`{prompt, voice, seed, audio_format: "opus"}`），把它的
  `audio/ogg` body 原样转发。不切句、不分块。客户端断开就 abort 那个请求。
- `skip_before` 不丢消息：那些消息只回文本（flags bit0 = 1），没有音频，由客户端决定怎么处理。
- 出声之前 TTS 就失败（音色不存在、连不上）→ 502，消息放回队列（最多 3 次）。
- 合成前先过 `Format.forTts`：`<!-- disable voice -->` 段不念（文本照旧保留）。
- 请求 `outputFormat: "opus"`；回来的不是 Ogg 才本地转（**镜像里没有 ffmpeg**，理由见
  [Dockerfile.brains](../Dockerfile.brains) —— 实测 TTS 认 `response_format=opus`，正常不会走到那一步）。
- **不控制采样率**：TTS 回什么就透传什么（`format === "ogg"` 时字节不动、不重采样）。所以"下行 24k"
  不是我们的承诺 —— 客户端按解码器实际输出处理（见 [client-notes.md](./client-notes.md)）。

### 日志

`docker compose logs -f brains`：

- `[agent] +1 <brain> <asr|warning> q=a→b "<前 60 字>"` —— 入队；撞上限时同一行带 `DROPPED-OLDEST`。
- `[agent] -1 <brain> q=a→b "<前 60 字>"` —— 出队；客户端已断开时带 `ABORTED(…这条丢了)`。
- `[tts] <brain> 客户端 skip_before 跳过 "…"` —— 客户端带了 `skip_before`，这条只发文本不发音频。
- `[tts] <brain> 客户端 skip_before 跳过 "…"` / `整段都被静音了，只发文本 "…"` /
  `没有音色可用，只发文本 "…"` / `连续 3 次失败，丢掉 "…"`。
- `[brain] <brain> 第一次出现，已创建` / `空闲超过 2 小时，已卸载`。

对账方式：**push 条数 = 出队条数 + 队里剩的条数**，对不上就是撞了上面两条之一。

## 会咬人的地方

1. **容器里 `node` 是 PID 1**，内核不对 PID 1 施加"默认动作"信号。`main.ts` 里那个 SIGTERM
   handler 不是装饰 —— 删了它，`docker compose stop` 会等满 10 秒 grace 再 SIGKILL（退出码 137）。
2. **`server.close()` 会被 undici 的 keep-alive 连接挂住**，测试直接卡死。先
   `closeAllConnections()` 再 `close()`。
3. **错误响应不能长得像成功响应**：客户端按端点分派 Content-Type，错误体长成
   `application/msgpack` / `application/json` 就会被当成合法回复。一律 `text/plain`。
   `brain_id` 没有白名单，所以不存在“没有这个 brain”这条失败路径。
4. **provider 不是 model。** `createOpenAICompatible(...)` / `createOpenAI(...)` 返回的是 provider，
   它跟 model 都有 `specificationVersion`，不给 AI SDK 一个真正的 model，它会死在
   `resolvedModel.provider.split(".")` 上（`TypeError: Cannot read properties of undefined`）。
5. **`@ai-sdk/openai-compatible` 的音频白名单只有 wav / mp3**（上游 3.0.69 仍如此），喂 Ogg Opus 会抛
   `UnsupportedFunctionalityError`。绕法见 [packages/chat/.../openai-compatible-ogg.ts](../packages/chat/src/v1/adapter/openai-compatible-ogg.ts)。
6. **`brain_id` 没有白名单。** 拼错一个字母就是另一段对话，而且 2 小时空闲后状态会被卸载 ——
   排障时先确认客户端真的每次都发同一个名字。

## 验证

```bash
pnpm verify                      # check + lint + test
node apps/brains/src/main.ts     # 空配置下应带清晰报错退出
```

端到端（要真实 `.env`）；`<brain>` 换成客户端会发的那个名字（随便取，服务端现建）：

```bash
# agent 那两个直接 JSON
curl -sS -X POST localhost:18781/brain-to-agent \
  -H 'content-type: application/json' -d '{"brain_id":"<brain>"}'

# 带音频的那两个只能 MessagePack：body 得先编好
curl -sS -X POST localhost:18781/brain-to-human \
  -H 'content-type: application/msgpack' --data-binary @request.msgpack -o frames.bin
```

响应是「前导 + Ogg 流」：前 4 字节是文本长度（大端），接着是 UTF-8 文本、1 字节 flags，
然后是音频。不能当单个 msgpack 对象解；要验就看 `http.test.ts` 里的 `readSpeech`，或者直接听。

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
