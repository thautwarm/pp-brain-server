# Brain API 规格

手机端只做两件事：**采音**和**放音**。识别、对话、合成全部由 brain 承担。

这样一来手机上不再需要 STT/TTS 引擎，只需要一个 brain 客户端。
对话状态（上下文、历史）全部挂在 `brain_id` 上，手机端不持有任何状态。

四个端点刚好是一张 2×2：**谁（human / agent）× 方向（进 brain / 出 brain）**。
名字就是 `<from>-to-<to>`，机械推导，不用记。方向本身预告了 HTTP 语义：
`*-to-brain` 是提交、立即返回；`brain-to-*` 是长轮询、可以空手而归。

---

## 0. 前置约定

### 0.1 `brain_id` —— 人起的名字，不是生成的

**它像人的名字一样有语义**，标识"你在跟哪个 brain 说话"，
由用户在客户端配置。

```
brain_id = "员工3"
```

由此推出几件事：

- 客户端只需要一个**文本输入框**，不需要 UUID 生成器，
  也不需要服务端发号接口
- 状态按名字存在服务端，所以**同一个 `brain_id` 跨 App 重启仍是同一段对话**
- 想开一段全新的对话，就换一个名字
- 它出现在每个请求里，同一段对话里两边必须一致，
  否则会问到两个不同的 brain

### 0.2 认证 —— Bearer token

**四个端点都支持**：

```http
Authorization: Bearer <token>
```

- token 由用户在客户端配置（和 `brain_id` 一样是设置项，不是生成的）
- **token 可能为空** —— 即该部署没有启用鉴权。
  客户端在 token 为空时**不发送** `Authorization` 头
  （而不是发一个空的 `Bearer `，那样容易被服务端判成格式错误）

> 客户端注意：401 **不要**当作"网络问题"无限重试 ——
> 那会把一个配置错误变成持续请求。应当直接提示用户"token 无效"。
> （协议层没有 `kind: "error"`，但 HTTP 状态码仍然存在，
> 鉴权失败属于这一类。）

### 0.3 编码 —— MessagePack 和 JSON

body 有两种编码，带不带二进制说了算：

| 端点 | body 编码 |
|---|---|
| `/human-to-brain`、`/brain-to-human` | **只能 MessagePack**（`application/msgpack`）—— body 里就是音频 |
| `/agent-to-brain`、`/brain-to-agent` | **MessagePack 和 JSON 都收**（`application/msgpack` / `application/json`） |

- 带音频的 body 必须用 MessagePack：二进制（`Uint8Array` = msgpack 的 **bin**）和结构化字段
  装在**同一个对象**里，不用 multipart、不用 boundary、不用 base64。
- 纯文本的 body 两种都行：JSON 让不装 msgpack 库的客户端也能直接调那两个端点。
- **agent 那对的响应跟着请求的编码走**：JSON 进 JSON 出，msgpack 进 msgpack 出，不用配 `Accept`。
- body 一定是一个对象（map / object），不是数组或裸值。
- 错误一律 `text/plain` + HTTP 状态码。
- 客户端仍然需要一个 MessagePack 实现（Dart 侧 `msgpack_dart` 之类）——音频那对躲不掉。

---

## 1. 端点

### 1.1 `POST /human-to-brain`

把一段人类语音交给 brain，返回转录。

**request**：

```ts
{
  brain_id: string,
  audio: Uint8Array,              // Ogg Opus 16kHz（见 §4）
  unheard_text?: string | null,   // 打断时补的，见下
}
```

`unheard_text` 是**打断**时补上来的那段：agent 已经说出来、但人类没听到的话。**可空** —— 不给、
给 `null`、给空串都算"这次没有"。

给了的话，brain 会把它裹成下面这个块，**插在交给 agent 的文本前面**（也就是 §1.4 取到的东西）：

```
<unheard_text reason="用户打断讲话">
第一句没听完
第二句也没听完
</unheard_text>
<asr-recognized-text>…</asr-recognized-text>
```

> ⚠️ 注意它裹的**不是**人类说的话，是 agent 自己说过、人类没听到的话 —— 跟
> `<asr-recognized-text>` 不是一类，别混。
>
> 多行时内容两侧各留一个换行、内容 trim 掉（单行则原样贴着标签）。`reason` 目前写死。

**response**：

```ts
{ kind: "text", text: string }
```

> 只有转写该拖住这个请求：进 history、跑模型、合成都该甩到后台。
> 用户每说一句都要等到整轮生成完才拿到文本的话，这个接口就白设计了。

> body 只走 MessagePack（见 §0.3）—— `audio` 就是 msgpack 的 bin。

---

### 1.2 `POST /brain-to-human`

取 brain 对人类的回复。**阻塞请求** —— 挂住直到有话要说或超时。

> body 只走 MessagePack（见 §0.3）—— 回声的 `audio` 就是 msgpack 的 bin。

**request**：

```ts
{ brain_id: string }
```

**response**：

```ts
{ kind: "empty" }                                    // 没话说，客户端立刻再问
| { kind: "text", text: string, audio: Uint8Array }  // audio = Ogg Opus 24kHz
```

---

### 1.3 `POST /agent-to-brain`

agent 把一段文本交给 brain。

**request**：

```ts
{ brain_id: string, text: string }
```

**response**：

```ts
{ kind: "empty" }
```

> 写入端点没有"等"的语义，收下即返回。等是出 brain 那两个端点的事。
> 写入又没有可回报的产物，所以跟长轮询超时一样回 `empty`。

> 这一对（§1.3 / §1.4）`application/json` 和 `application/msgpack` 都收，
> **响应跟着请求的编码走**（见 §0.3）。

---

### 1.4 `POST /brain-to-agent`

取 brain 下放给 agent 的文本。**阻塞请求** —— 同 §1.2。

**request**：

```ts
{ brain_id: string }
```

**response**：

```ts
{ kind: "empty" }
| { kind: "text", text: string }
```

> 内容多半是人类语音的转录，也可能是别的东西（`<unheard_text>` 打断块 —— 见 §1.1、压缩后的
> history、工具结果、修订给的警告）—— 所以这里只承诺是文本，不承诺它一定是转录。

---

## 2. 编码细节

- 成功响应一律是一个对象：MessagePack 是 map，JSON 是 object。
- **音频是 MessagePack 的 bin**（`Uint8Array`），原样二进制；不是 base64，也不是单独的 part。
  JSON 里装不下，所以音频那两个端点不收 JSON。
- agent 那对：请求 `Content-Type: application/json` 就回 JSON，
  `application/msgpack`（或缺省）就回 msgpack。
- `empty` 也是普通对象 `{ "kind": "empty" }`——长轮询超时就返回它，客户端拿到立刻再问（见 §3）。

---

## 3. 客户端状态机

```
                 ┌──────────────────────────┐
  开始对话 ──────▶│ 轮询 /brain-to-human     │
                 │ (阻塞，返回 empty 就再来) │
                 └──────────┬───────────────┘
                            │ kind=text
                            ▼
                 ┌──────────────────────────┐
                 │ 解码 Ogg → PCM16 → 播放   │◀──┐
                 └──────────┬───────────────┘   │
                            │ 播完               │
                            └───────────────────┘

   同时，另一条路：
   VAD 切出一句话 ──▶ POST /human-to-brain ──▶ 得到人类文本
```

两条路并行：一边持续问 brain 有没有话说，一边把用户说的话送过去。

> `empty` 只是"暂时没话说"，客户端**立刻再发一次**，不停不等。
> 协议层**没有错误响应** —— 唯一的失败来源是网络，
> 由客户端自己重试（退避 + 上限），不要往外抛。

### 打断语义 —— 已对齐

- 回复的**文本永远进入消息流**，无论语音是否被打断
- 只有 **AI 语音**会被清空
- **不做自动打断（barge-in）**：收到就播，不做双讲检测
- 因此**不需要服务端加 `since` 字段**。客户端本地用 `epoch` 就够：
  清空播放队列时 `epoch++`，在途的音频分块全部作废；
  文本该进消息流照样进
- 清空播放队列是**手动**动作（触发方式见 §6）

---

## 4. 音频格式

| 方向 | 格式 | 采样率 |
|---|---|---|
| 上行（`/human-to-brain`） | `audio/ogg`，Ogg Opus | **16kHz** |
| 下行（`/brain-to-human`） | `audio/ogg`，Ogg Opus | **24kHz** |

两个方向都是 Ogg Opus，但**采样率不同** —— 跟着两端的模型走：
STT 吃 16k，TTS 出 24k。

> 这一点有实测佐证：现有 MOSS-TTS 的 `pcm` 输出就是 **24000Hz**
> （`/v1/audio/speech` 返回的 WAV 头里读出来的）。

音频在 MessagePack 里就是 bin 字段（`audio`），没有独立的媒体类型头。

对客户端意味着**两个方向都要做 Opus 编解码**，而且下行还要重采样：

| 方向 | 客户端要做的事 |
|---|---|
| 上行 | PCM16 16k → **Opus 编码** → Ogg 封装 |
| 下行 | Ogg 解封装 → **Opus 解码** → **重采样到引擎速率（16k）** |

纯 Dart 没有可用的 Opus 编解码器，所以两块都得走原生：

- **解码**：`MediaExtractor` + `MediaCodec`
- **编码**：`MediaCodec`（`audio/opus`）+ `MediaMuxer`（`MUXER_OUTPUT_OGG`）

> ⚠️ **别假设解码出来的采样率等于声明的采样率。**
> Opus 内部固定跑 48kHz，Ogg Opus 头里的 "input sample rate" 只是提示信息。
> Android 的 `MediaCodec` 解码 Opus 通常**直接给 48000Hz**。
> 客户端必须**读解码器实际输出的采样率**再重采样，不能写死 24k ——
> 否则会变速（音调变低、语速变慢），而且很难查。

> ⚠️ `MediaMuxer.OutputFormat.MUXER_OUTPUT_OGG` 需要 **API 29+**。
> 当前 App 的 `minSdk` 是 24，所以要么把 minSdk 提到 29，
> 要么在低版本上退化。**这条需要你定**。

---

## 5. 待确认

1. **brain API 的 base URL** —— 还没给，无法实测。
2. **`minSdk`**：上行要 Ogg 封装需要 `MUXER_OUTPUT_OGG`（API 29+），
   而当前 `minSdk` 是 24。提到 29，还是低版本退化发 WAV？

### 已确认（不再是问题）

- ✅ **`brain_id` 是人起的名字，不是生成的**（见 §0）
- ✅ **body 编码两种**：音频那两个端点只能 MessagePack，agent 那两个 JSON / MessagePack 都收，
  响应跟着请求走（见 §0.3）
- ✅ `/brain-to-human` 收到 `empty` 就**继续轮询**，不停不等
- ✅ **不存在协议层错误响应**，只有网络问题，客户端自己重试
- ✅ 上行 Ogg Opus **16kHz**、下行 Ogg Opus **24kHz**（两个方向采样率不同）

---

## 6. 清空播放队列的触发方式 —— 未定

不做自动打断之后，"清空 AI 语音"需要一个手动触发。

你提的是「按音量键减」。技术约束：

- 音量键只能在 App **处于前台**时拦截（Activity 的 `onKeyDown`），
  后台/锁屏收不到 —— 而这个 App 的设计目标恰恰是后台可用
- 拦截会吞掉正常的音量调节。建议只在"正在播放 AI 语音"时拦截，其余放行
- 通知栏加一个「停止说话」按钮可以覆盖后台/锁屏，且不与系统音量键冲突

**待定**：两个都做 / 只做通知按钮 / 只做音量键。

---

## 7. 对现有代码的影响

| 现状 | 改动 |
|---|---|
| `SttEngine` / `TtsEngine` / `AssistantBrain` 三个抽象 | 合并成一个 `BrainClient` |
| `HttpSttEngine` / `HttpTtsEngine` / `EchoBrain` | 删除 |
| 双讲打断（阈值 / 双讲余量 / `playbackLevel`） | **删除** —— 改为手动清空队列 |
| 本地 VAD（`EnergyVad`） | **保留** —— 仍然需要它切出完整的一句话再上传 |
| 原生音频引擎 | 保留；新增 Ogg 解码 |
| 事件日志 / 调试面板 / AEC 实测 | 保留 |
| body 编解码 | 音频那对用 MessagePack 实现（`msgpack_dart` 之类）；agent 那对也可以用 Dart 自带的 `dart:convert` |
