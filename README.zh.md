# pp-brain-server

自托管的 Brain API 服务端，给 [PP Friend](https://github.com/thautwarm/pp-friend) 用。手机端只采音放音，转写、修订、合成都由这个服务承担；agent 侧把它当一条纯文本通道。

[English](README.md) | 中文

## 快速部署

**前置条件**

- Docker + Compose 插件。
- 三个能连通的上游（通常在局域网里）：
  - OpenAI 兼容的 STT 端点，底下拼 `/audio/transcriptions`；
  - 流式 TTS 端点，底下拼 `/audio/speech/stream`
    （[moss-tts-windowed](https://github.com/thautwarm/moss-tts-windowed) 用的就是这套形状）；
  - OpenAI 兼容的对话端点，给修订/摘要用。

**部署**

```bash
git clone https://github.com/thautwarm/pp-brain-server.git && cd pp-brain-server
cp .env.example .env       # 填端点、密钥、模型名，填完再起
docker compose up -d --build
```

`.env` 里**必须填**：`STT_API_BASE_URL`、`TTS_API_BASE_URL`、`TTS_VOICE`、`MIGHT_CHAT_API_KEY`、
`MIGHT_CHAT_API_BASE_URL`。缺了必填项会在启动时指名报错退出，不会起来一个半死的服务。

> **空值不等于"用默认值"**。代码里是 `process.env.X ?? 默认值`，空串会把默认值顶掉。所以
> 可选项在模板里一律注释着，不给就别解开。另外 `.env` 只支持整行注释（`#` 开头），行尾的
> `#` 会被当成值的一部分。

**看日志**

```bash
docker compose logs -f brains
# 期望看到：brains 听着 8787（鉴权关）   —— 设了 token 则是「鉴权开」
```

**验证** —— 服务端没有 `/health`，用下面任意一种：

```bash
docker compose ps                 # 容器 might-brains-1 在跑
docker compose logs brains        # 上面那行监听日志

# 发一个预期 400 的请求，证明 HTTP 层已经在听
#（400 = body 形状不对，缺 brain_id；设了 token 就带上
#  -H 'authorization: Bearer <token>'，否则会得到 401）
curl -sS -o /dev/null -w '%{http_code}\n' -X POST http://localhost:18781/brain-to-agent \
  -H 'content-type: application/json' -d '{}'
```

**客户端怎么连** —— PP Friend 里服务端填 `http://<host>:18781`（宿主 18781 → 容器 8787）。
`brain_id` 是任意非空字符串，自己选、要稳定：服务端第一次见到就现建，拼错名字不会报错，
只会开一段新对话。设了 `MIGHT_BRAINS_TOKEN` 就按 `Authorization: Bearer <token>` 带；
token 为空就是不启用鉴权，客户端不发这个头。

## 使用

四个端点刚好是一张 2×2：谁（人类 / agent）× 方向（进 brain / 出 brain）。一律 `POST`，
名字机械推导 `<from>-to-<to>`：

| 端点 | 方向 | 语义 | 请求体编码 |
| --- | --- | --- | --- |
| `POST /human-to-brain` | 人类 → brain | 提交一段语音（Ogg Opus 16 kHz 单声道），返回转写文本 | 仅 MessagePack |
| `POST /brain-to-human` | brain → 人类 | 长轮询，取给人类的语音，**前导 + Ogg 流** | 仅 MessagePack |
| `POST /agent-to-brain` | agent → brain | 提交一段文本，立即返回，由服务端合成语音 | MessagePack / JSON |
| `POST /brain-to-agent` | brain → agent | 长轮询，取 brain 下放给 agent 的文本 | MessagePack / JSON |

**两种调用方式。** agent 那对 JSON 和 MessagePack 都收，响应跟着请求的编码走（JSON 进
JSON 出）。人类那对**只能 MessagePack**：`/human-to-brain` 的 body 里装着音频二进制，
msgpack 的 bin 类型能把字节和结构化字段装进同一个对象，不用 multipart、不用 base64；
`/brain-to-human` 只是一个小 map，沿用同一约定。`curl -d` / `-F` 产不出 msgpack ——
用任意 msgpack 编码器把 body 编成文件再发。

最小示例（占位符：`<host>`、`<token>`、`<brain>`）：

```bash
# agent → brain：推一段要念的文本（立即返回）
curl -sS -X POST http://<host>:18781/agent-to-brain \
  -H 'authorization: Bearer <token>' \
  -H 'content-type: application/json' \
  -d '{"brain_id":"<brain>","text":"你好，这里是 agent。"}'

# brain → agent：长轮询取人类说的话（或修订告警）
curl -sS -X POST http://<host>:18781/brain-to-agent \
  -H 'authorization: Bearer <token>' \
  -H 'content-type: application/json' \
  -d '{"brain_id":"<brain>"}'

# brain → human：长轮询取语音。body 得先编成 MessagePack
curl -sS -X POST http://<host>:18781/brain-to-human \
  -H 'authorization: Bearer <token>' \
  -H 'content-type: application/msgpack' --data-binary @request.msgpack -o frames.bin
```

**`/brain-to-human` 的响应**是 `application/octet-stream`：

```
[u32 大端 文本长度][UTF-8 文本][1 字节 flags][Ogg Opus 流…]
```

文本一次到齐，音频是连续流——直接喂解码器，不要按块拼。`flags` 的 bit0 表示这条是被
`skip_before` 跳过的旧消息：只有文本，body 里没有音频。文本长度 = 0 表示这一轮没内容，
客户端立刻重发，不要退避。这个 body 不能当单个 msgpack 对象解；要验就看
`apps/brains/src/http.test.ts` 里的 `readSpeech`，或者直接听。

**`skip_before`**（可选，UTC epoch **毫秒**，客户端的钟）：早于这个时刻入队的 agent 消息
不合成，只回文本并把 flags bit0 置 1，一条响应最多一条，客户端重发逐条排空。用于用户
清掉积压语音的场景。

**`unheard_text`**（`/human-to-brain` 的可选字段）：用户打断时没听完的那段（agent 已产生、
人类没听到的部分），服务端把它前置到这次转写之前一并交给 agent。缺省、`null`、空串都算
"这次没有"。

**音色**：可选请求头 `x-brain-voice`（旧名 `x-might-voice` 也认），只作用于这一条消息，
只在 `/agent-to-brain` 上影响合成；不带就用部署方的 `TTS_VOICE`。`text` 里
`<!-- disable voice -->` 到 `<!-- enable voice -->` 之间的区段只上屏不念。

完整契约（唯一权威）见 [docs/brain-api-spec.md](docs/brain-api-spec.md)。

## 配置

全部写在 `.env` 里（模板见 `.env.example`），经 `env_file` 进容器——不烘进镜像，也不入库。

| 变量 | 用途 |
| --- | --- |
| `STT_API_BASE_URL` / `STT_API_KEY` / `STT_MODEL` | 转写端点（OpenAI 兼容，baseURL 底下拼 `/audio/transcriptions`）；`STT_MODEL` 不给则用 `qwen-asr` |
| `TTS_API_BASE_URL` / `TTS_API_KEY` | 合成端点，拼 `/audio/speech/stream`（流式 TTS）；`TTS_MODEL` **不再使用**，模型/音色由 daemon 决定 |
| `TTS_VOICE` | **必填**。默认音色，名字得是 daemon 认的（`default` = 不用参考音色）。填错不会启动失败，但每次合成都会 502（日志里有原因） |
| `MIGHT_CHAT_API_KEY` / `MIGHT_CHAT_API_BASE_URL` | 修订/摘要用的对话端点 |
| `MIGHT_CHAT_MODEL` | 修订用的模型名 |
| `MIGHT_BRAINS_TOKEN` | 路由鉴权；空 = 不启用 |
| `MIGHT_BRAINS_PORT` | 监听端口，默认 8787（容器内端口；compose 里宿主 18781 映射到它） |
| `MIGHT_BRAINS_POLL_TIMEOUT_MS` | 长轮询上限，默认 25000；`/brain-to-human` 只约束等到有内容，开始出声后可以挂到说完 |
| `MIGHT_LOG_LLM` | 设成 `1` 就把发往 chat 模型的请求/响应写到 `logs/revise/<日期>/<uuid>/{request,response}.json`。**含完整对话内容**，只在排查时开 |
| `MIGHT_LOG_LLM_DIR` | 落盘根目录，默认 `logs`（compose 里挂到宿主同名目录） |

再强调一遍：缺必填项启动即指名退出；空值不等于默认值（见快速部署）；长轮询超时只意味着
"这轮没内容"，客户端收到空结果应立即重发。

## 运维与排障

```bash
docker compose logs -f brains     # 运行时的信息全在这里
docker compose restart brains     # 状态全内存：重启即清零所有对话
```

**日志行**

- `[agent] +1 <brain> <asr|warning> q=a→b "<前 60 字>"` —— 入队；撞上限时同一行带 `DROPPED-OLDEST`。
- `[agent] -1 <brain> q=a→b "<前 60 字>"` —— 出队；客户端已断开时带 `ABORTED(…这条丢了)`。
- `[in] <brain> agent voice=… "…"` —— agent 推文本进来（含这次用的音色）。
- `[tts] <brain> voice=… "…"` —— 实际交给 TTS 的音色和文本；失败/跳过/丢消息也在这一族。
- `[tts] <brain> 客户端 skip_before 跳过 "…"` —— 客户端带了 `skip_before`，这条只发文本不发音频。
- `[b2h] <brain> empty` / `speech N 字 M B T ms` / `客户端断开 M B` / `中断 M B` —— 每次
  `/brain-to-human` 的结局和实际发出的字节数。
- `[llm] <uuid> <状态码> <耗时>` —— 只有 `MIGHT_LOG_LLM=1` 时才有；内容在那个 uuid 的
  `logs/revise/<日期>/<uuid>/request.json` 和 `response.json` 里。
- `[brain] <brain> 第一次出现，已创建` / `空闲超过 2 小时，已卸载`。

对账方式：**push 条数 = 出队条数 + 队里剩的条数**，对不上就是撞了上面两条丢消息路径之一。

**上限与生命周期**

- 每个 brain 每个方向的队列上限 64 条，满了丢**最旧**的一条。投递是读即消费：无确认、无重投、
  单消费者——两个客户端轮询同一个出向队列是竞争消费，各自抢走一部分，不是广播。
- `brain_id` 第一次出现时现建，**空闲 2 小时被后台卸载**（不然一串随机名字就能把内存吃光）。
  状态和队列全在内存里，重启即清零。
- 上游超时：转写 13 秒（超时回 502）；长轮询默认 25 秒。

**常见故障**

| 症状 | 可能原因 |
| --- | --- |
| 每次合成都 502 | `TTS_VOICE` 填了 TTS daemon 不认的音色名。启动不会拦——原因在 `[tts]` 日志里 |
| `/human-to-brain` 502 | STT 上游挂了或超过 13 秒上限 |
| 全部 401 | token 对不上；服务端 token 为空 = 不启用鉴权，此时客户端不应发 `Authorization` 头 |
| 端口被占 | 改 `docker-compose.yaml` 里 `ports:` 的左半边（宿主侧）；容器侧保持 8787，除非同时改 `MIGHT_BRAINS_PORT` |
| 客户端"串台"到别的对话 | `brain_id` 拼错了——没有白名单，拼错就是开一段新对话；另外确认客户端每次都发同一个名字（空闲 2 小时后状态会被卸载） |
| `docker compose stop` 等满 10 秒、退出码 137 | 容器里 `node` 是 PID 1，内核不对 PID 1 施加默认信号动作。`main.ts` 里那个 SIGTERM handler 不是装饰，别删 |

## 运行模型

- **全内存。** 每个 brain 的 history 和队列都在进程里，重启即清零。（`ChatAgent.codec` 已经
  能序列化会话，要落盘是加一个模块的事。）
- **全双工。** 人类侧一边持续长轮询"有没有话说"，一边把语音送上去，两条路并行。可打断：
  用户开口，客户端清掉播放队列，`unheard_text` 把没听完的部分补回给 agent。
- **流式合成。** 合成不在后台跑：`/brain-to-human` 这个请求自己逐块合成、边合边吐
  （`POST /audio/speech/stream`，把 `audio/ogg` body 原样转发，不切句、不重采样；客户端
  断开就 abort 上游请求）。没人轮询就不合成。
- **后台修订。** 一个 35 ms 一跳的循环管两件事：修订（每攒够 3 条新交互，把最近转录投影给
  外部对话模型——音频只带尾部最多 7 条——它可以用 `notify` 工具给 agent 发 `<asr-warning>`
  告警；单轮 token 超 10240 就顺手压缩 history）和空闲淘汰（10 秒扫一次，卸掉 2 小时没交互的
  brain）。
- **失败的位置。** 出声之前 TTS 就失败（音色不存在、连不上）→ 502，消息放回队列（最多 3 次）；
  流到一半挂掉则 body 直接结束，和正常说完只能靠 Ogg EOS page 区分。

细节见 [docs/brains.md](docs/brains.md)（运行时行为、日志、坑）和
[docs/brain-api-spec.md](docs/brain-api-spec.md)（线上契约）。

## 开发

Node 24 原生跑 TypeScript，零构建，没有 `dist/`：

```bash
pnpm install
pnpm verify                                  # check + lint + test
node --env-file=.env apps/brains/src/main.ts # 不起容器直接跑
node apps/brains/src/main.ts                 # 空配置下应带清晰报错退出
```

代码结构：

```
packages/chat/        @might/chat —— 会话的事实层（UIMessage / ChatAgent）+ 凭据→模型的 adapter
packages/audio/       @might/audio —— 语音的事实层（合成 / 转写 / Ogg Opus）
apps/brains/          Brain API 的服务端本体
  src/http.ts         路由、鉴权、请求校验、长轮询、语音响应
  src/brain-center.ts 队列、history、逐块合成、日志
```

改仓库之前先读 [DEVDOCS.md](DEVDOCS.md)。

## 文档

- [docs/brain-api-spec.md](docs/brain-api-spec.md) —— 接口契约（唯一权威）
- [docs/brains.md](docs/brains.md) —— 服务端怎么跑、配置、运行时行为、日志、会咬人的地方
- [docs/client-notes.md](docs/client-notes.md) —— 手机端实现笔记
- [DEVDOCS.md](DEVDOCS.md) —— 这个仓库怎么搭的、为什么这么搭
- [`site/`](site/) —— 站点源码（`index.html` + `brain-api/`），尚未发布（GitHub Pages 需要仓库公开）
