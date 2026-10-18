# pp-brain-server

自托管的 Brain API 服务端，给 [PP Friend](https://github.com/thautwarm/pp-friend) 用。手机端只采音放音，转写、对话、合成都由这个服务承担；agent 侧把它当一条纯文本通道。

站点源码在 [`site/`](site/)（纯静态页，尚未发布：GitHub Pages 需要仓库公开）。

## 它是什么

- **全双工**：人类侧一边持续轮询"有没有话说"，一边把语音送上去，两条路并行。
- **可打断**：用户开口就清空播放队列，`unheard_text` 把没听完的部分补回给 agent。
- **流式合成**：整条回复交给流式 TTS，音频边生成边转发，不等整条合成完才开口。
- **状态全内存**：每个 `brain_id` 的历史和队列都在进程里，空闲 2 小时卸载，重启即清零。
- **自己不跑模型**：转写、合成、对话都打外部端点，地址由 `.env` 给。

## 端点

| 端点 | 方向 | 语义 |
| --- | --- | --- |
| `POST /human-to-brain` | 人类 → brain | 提交一段语音（Ogg Opus 16 kHz），返回转写文本 |
| `POST /brain-to-human` | brain → 人类 | 长轮询，取给人类的语音，**前导 + Ogg 流** |
| `POST /agent-to-brain` | agent → brain | 提交一段文本，立即返回，由服务端合成语音 |
| `POST /brain-to-agent` | brain → agent | 长轮询，取 brain 下放给 agent 的文本 |

`/brain-to-human` 的响应是 `application/octet-stream`：`[u32 大端 文本长度][UTF-8 文本][1 字节 flags][Ogg Opus 流]`。文本一次到齐，音频是连续流；`flags` 的 bit0 表示这条是 `skip_before` 跳过的旧消息。细节见 [docs/brain-api-spec.md](docs/brain-api-spec.md)。

## 快速开始

```bash
cp .env.example .env       # 填端点、密钥、模型名，填完再起
docker compose up -d --build
```

接口在 `localhost:18781`（宿主 18781 → 容器 8787）。鉴权走 `Authorization: Bearer <token>`，token 留空就是不启用。

## 配置

全部写在 `.env` 里（模板见 `.env.example`）。关键项：

| 变量 | 用途 |
| --- | --- |
| `STT_API_BASE_URL` / `STT_API_KEY` / `STT_MODEL` | 转写端点（OpenAI 兼容，`/audio/transcriptions`） |
| `TTS_API_BASE_URL` / `TTS_API_KEY` / `TTS_MODEL` | 合成端点（同上，`/audio/speech`） |
| `TTS_VOICE` | **必填**，默认音色；请求头 `x-brain-voice` 可按条覆盖 |
| `MIGHT_CHAT_API_KEY` / `MIGHT_CHAT_API_BASE_URL` | 修订/摘要用的对话端点 |
| `MIGHT_BRAINS_TOKEN` | 路由鉴权；空 = 不启用 |
| `MIGHT_BRAINS_POLL_TIMEOUT_MS` | 长轮询上限，默认 25000 |

缺了必填项会在启动时指名报错退出，不会起来一个半死的服务。

## 代码结构

```
packages/chat/        @might/chat —— 会话的事实层（UIMessage / ChatAgent）+ 凭据→模型的 adapter
packages/audio/       @might/audio —— 语音的事实层（合成 / 转写 / Ogg Opus）
apps/brains/          Brain API 的服务端本体
  src/http.ts         路由、鉴权、请求校验、长轮询、语音响应
  src/brain-center.ts 队列、history、逐块合成、日志
```

## 文档

- [docs/brain-api-spec.md](docs/brain-api-spec.md) —— 接口契约（唯一权威）
- [`site/`](site/) —— 给人看的站点源码（`index.html` + `brain-api/`）
- [docs/brains.md](docs/brains.md) —— 服务端怎么跑、配置、运行时行为、日志
- [docs/client-notes.md](docs/client-notes.md) —— 手机端实现笔记

## 开发

Node 24 原生跑 TypeScript，零构建：

```bash
pnpm install
pnpm verify        # check + lint + test
node apps/brains/src/main.ts   # 空配置下应带清晰报错退出
```

改仓库之前先读 [DEVDOCS.md](DEVDOCS.md)。
