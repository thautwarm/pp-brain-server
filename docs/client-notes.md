# 手机端笔记

这是**客户端实现**要的东西，不是接口契约 —— 契约在 [brain-api-spec.md](./brain-api-spec.md)。
分开放是因为规格只管线上协议，不管手机怎么把音频接起来。

## 两条路并行

```
                 ┌───────────────────────────┐
  开始对话 ──────▶│ 轮询 /brain-to-human      │
                 │ (读到帧就播，empty 就再来) │
                 └──────────┬────────────────┘
                            │ 每一帧
                            ▼
                 ┌───────────────────────────┐
                 │ 解码 Ogg → PCM16 → 播放    │◀──┐
                 └──────────┬────────────────┘   │
                            │ 本帧播完            │
                            └────────────────────┘

   同时，另一条路：
   VAD 切出一句话 ──▶ POST /human-to-brain ──▶ 得到人类文本
```

一边持续问 brain 有没有话说，一边把用户说的话送过去。收到 `empty` 就**立刻再发一次**（规格 §7）。

`brain_id` 自己选、要稳定：服务端第一次见到就建，空闲 2 小时后卸载（规格 §4）。音色用
`x-brain-voice` 头（旧名 `x-might-voice` 也认）。两个提交端点都能带，但只有 `/agent-to-brain`
上的会影响合成：一条消息一个音色，不带就用部署方配的默认音色（规格 §3.3）。

## brain-to-human：分帧流

`/brain-to-human` 的响应**永远**是一串帧（没有"单个 MessagePack"那种形态了）：

```
while (true) {
  read 4 bytes -> length (big-endian u32)
  read length bytes -> MessagePack -> { kind, text, audio }
  if (kind == "empty") break        // 超时，没有内容，重发
  enqueue(audio)                     // 每帧是独立的 Ogg 文件
}
// body 正常结束 = 这一条说完了
```

- **第一帧没有音频**：`{ text, sentences, skipped }`。`text` 是整条原始回复（`<!-- disable voice -->`
  段也在里面），`sentences` 是服务器切好的句子表——文字可以立刻上屏。
- **之后每帧** `{ text, audio, consumed_sentences }`：`text` 是这一块念的内容，`consumed_sentences`
  是累计句数。被打断时用"总句数 − consumed_sentences"算还剩几句没听到，比按毫秒估准。
- **每帧的 `audio` 自己解码**，把 PCM 追加到播放队列；不要把一个帧的字节拼到另一个后面当
  一个 Ogg 用。
- 首帧通常会在一两秒内到（服务端把回复切成 ~32 权重的小块先合成），之后按 80 权重一块接一块；
  所以不需要等整条回复合成完就开始播。
- 中途断了（读不到完整一帧）就当这条丢了：重新发请求，服务端不会重投。
- **跳过积压**：下一个请求带 `skip_before: Date.now()`（UTC 毫秒，就用手机自己的钟）——比这个
  时刻早入队的消息不会合成，但会以 `skipped: true` 的文本帧回给你；你决定是显示、忽略、还是记进
  下一次的 `unheard_text`。

## 打断语义

- 回复的**文本永远进消息流**，无论语音是否被清空。
- 只有 **AI 语音**会被清空。
- **不做自动打断（barge-in）**：收到就播，不做双讲检测。
- 因此**不需要服务端加 `since` 字段**。客户端本地用 `epoch` 就够：清空播放队列时 `epoch++`，
  在途的音频分块全部作废；文本该进消息流照样进。
- 用户打断时，把"没听到的那段"通过 `unheard_text` 交给服务端（规格 §5.3）。

## 音频

上行 Ogg Opus 16 kHz；**下行的采样率不保证** —— 服务端原样透传 TTS 的产出，不重采样（规格 §6）。
两个方向都要 Opus 编解码，下行还要重采样：

| 方向 | 客户端要做的事 |
| --- | --- |
| 上行 | PCM16 16k → **Opus 编码** → Ogg 封装 |
| 下行 | Ogg 解封装 → **Opus 解码** → **重采样到引擎速率** |

纯 Dart 没有可用的 Opus 编解码器，两块都得走原生：

- **解码**：`MediaExtractor` + `MediaCodec`
- **编码**：`MediaCodec`（`audio/opus`）+ `MediaMuxer`（`MUXER_OUTPUT_OGG`）

> ⚠️ **别假设解码出来的采样率等于声明的采样率。** Opus 内部固定跑 48 kHz，Ogg Opus 头里的
> "input sample rate" 只是提示信息。Android 的 `MediaCodec` 解码 Opus 通常**直接给 48000 Hz**。
> 必须读解码器**实际输出的**采样率再重采样，**不能写死任何值**（24k 也不行）—— 否则会变速
> （音调变低、语速变慢），而且很难查。

> ⚠️ `MediaMuxer.OutputFormat.MUXER_OUTPUT_OGG` 需要 **API 29+**，当前 `minSdk` 是 24。

## 语速

服务端**不提供**语速控制：TTS 端点的 `speed` 字段存在但不生效，真正管时长的字段在这个部署上被
关掉了（实测报错"本部署不支持时长控制"）。所以语速只能在**客户端播放时**调 —— Android 播放器
原生支持播放速率（ExoPlayer 的 `PlaybackParameters`、`MediaPlayer.setPlaybackParams`），
0.5×–2.0×，而且是变速不变调。

## 待定

1. **`minSdk`**：上行 Ogg 封装要 `MUXER_OUTPUT_OGG`（API 29+），当前是 24。提到 29，还是低版本退化？
2. **清空播放队列的触发方式**（不做自动打断之后需要一个人工触发）：
   - 音量键只能在 App **前台**时拦截（Activity 的 `onKeyDown`），后台/锁屏收不到 —— 而这个 App 的
     设计目标恰恰是后台可用；拦截还会吞掉正常的音量调节（建议只在"正在播放 AI 语音"时拦）。
   - 通知栏放一个「停止说话」按钮能覆盖后台/锁屏，也不跟系统音量键冲突。
   - 待定：两个都做 / 只做通知按钮 / 只做音量键。
