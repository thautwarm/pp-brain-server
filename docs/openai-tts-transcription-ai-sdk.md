# OpenAI TTS / 语音转写 —— Vercel AI SDK 用法调研

> 调研日期: 2026-10-13 · 适用: AI SDK 4.x–7.x · 本文档为自包含参考，agent 可直接按此写代码。

## TL;DR（先读这段）

- TTS 用 `generateSpeech()`，转写用 `transcribe()`，都在 `ai` 包内，无需直接调 OpenAI REST API。
- **导入名跟 `ai` 版本有关（最容易写错的一点）**：

  | `ai` 版本       | 导入写法                                                                                                     |
  | --------------- | ------------------------------------------------------------------------------------------------------------ |
  | 4.x / 5.x / 6.x | `import { experimental_generateSpeech as generateSpeech, experimental_transcribe as transcribe } from 'ai';` |
  | 7.x（当前最新） | `import { generateSpeech, transcribe } from 'ai';`                                                           |

  v7 中旧名 `experimental_*` 仍可用但是 deprecated alias，未来大版本会删除。**先看 `package.json`
  里的 `ai` 版本再决定写哪个导入，或用 `as` 别名兼容两边。**
- 模型通过 provider 工厂拿：`openai.speech('gpt-4o-mini-tts')` 和
  `openai.transcription('whisper-1')`（注意是两个不同的方法名）。
- 认证：直连 OpenAI 读环境变量 `OPENAI_API_KEY`（provider 自动读取）；走 AI Gateway 用
  `AI_GATEWAY_API_KEY`。
- 错误都是可判别的类：`NoSpeechGeneratedError` / `NoTranscriptGeneratedError`，用 `.isInstance(err)`
  判断。
- 模型不支持的参数不抛错，出现在返回值的 `warnings` 里 —— 静默降级，务必检查。

安装（按需，直连 OpenAI）：

```bash
npm i ai @ai-sdk/openai
# 或走网关: npm i ai @ai-sdk/gateway
```

---

## 一、TTS — `generateSpeech`

### 基础用法

```ts
import { generateSpeech } from "ai"; // v<7: experimental_generateSpeech as generateSpeech
import { openai } from "@ai-sdk/openai";
import { writeFile } from "node:fs/promises";

const result = await generateSpeech({
  model: openai.speech("gpt-4o-mini-tts"), // 或 'tts-1' / 'tts-1-hd'
  text: "Hello from the AI SDK!",
  voice: "alloy",
  outputFormat: "mp3",
  providerOptions: {
    openai: {
      speed: 1.2, // 0.25–4.0，默认 1.0
      instructions: "Speak calmly.", // 仅 gpt-4o-mini-tts 生效，tts-1 / tts-1-hd 不支持
    },
  },
});

await writeFile("speech.mp3", result.audio.uint8Array);
```

### 参数（`generateSpeech`）

| 参数              | 类型                         | 说明                                                                                   |
| ----------------- | ---------------------------- | -------------------------------------------------------------------------------------- |
| `model`           | SpeechModel                  | 必填，如 `openai.speech('gpt-4o-mini-tts')`                                            |
| `text`            | `string`                     | 必填，要合成的文本                                                                     |
| `voice`           | `string`                     | 音色。OpenAI 支持: `alloy` `ash` `coral` `echo` `fable` `onyx` `nova` `sage` `shimmer` |
| `outputFormat`    | `string`                     | 如 `'mp3'` / `'wav'`，默认随 provider/model                                            |
| `instructions`    | `string`                     | 语气/风格指导（顶层参数；OpenAI 也可放 providerOptions）                               |
| `speed`           | `number`                     | 语速                                                                                   |
| `language`        | `string`                     | ISO 639-1（`'zh'`, `'en'`…）或 `'auto'`，provider 支持度不一                           |
| `providerOptions` | `Record<string, JSONObject>` | provider 专属选项，OpenAI 用 `{ openai: { … } }`                                       |
| `maxRetries`      | `number`                     | 默认 2                                                                                 |
| `abortSignal`     | `AbortSignal`                | 取消用，如 `AbortSignal.timeout(1000)`                                                 |
| `headers`         | `Record<string, string>`     | 额外 HTTP 头                                                                           |
| `telemetry`       | `TelemetryOptions`           | `functionId` 等                                                                        |

### 返回值

```ts
result.audio.uint8Array; // Uint8Array —— 写文件 / 塞进 Response body 用这个
result.audio.base64; // string
result.audio.mediaType; // 'audio/mpeg' 等
result.audio.format; // 'mp3' 等
result.warnings; // Warning[] —— 被忽略的选项会出现在这里
result.providerMetadata; // provider 附加信息（可选）
result.responses; // [{ timestamp, modelId, body?, headers? }]
```

### 错误处理

```ts
import { generateSpeech, NoSpeechGeneratedError } from "ai";

try {
  await generateSpeech({ model: openai.speech("gpt-4o-mini-tts"), text: "Hi" });
} catch (error) {
  if (NoSpeechGeneratedError.isInstance(error)) {
    console.log(error.cause, error.responses); // responses 含 timestamp/model/headers
  } else throw error;
}
```

### 完整示例：Next.js Route Handler 返回音频

```ts
// app/api/tts/route.ts
import { generateSpeech } from "ai";
import { openai } from "@ai-sdk/openai";

export async function POST(req: Request) {
  const { text, voice = "alloy" } = await req.json();

  const { audio } = await generateSpeech({
    model: openai.speech("gpt-4o-mini-tts"),
    text,
    voice,
  });

  return new Response(audio.uint8Array, {
    headers: { "Content-Type": audio.mediaType },
  });
}
```

前端直接 `<audio src="/api/tts" />` 或 fetch 拿 blob 即可（返回的是完整音频，**不是流式**）。

---

## 二、语音转写 — `transcribe`

### 基础用法

```ts
import { transcribe } from "ai"; // v<7: experimental_transcribe as transcribe
import { openai } from "@ai-sdk/openai";
import { readFile } from "node:fs/promises";

const transcript = await transcribe({
  model: openai.transcription("whisper-1"), // 或 'gpt-4o-transcribe' / 'gpt-4o-mini-transcribe'
  audio: await readFile("audio.mp3"),
  providerOptions: {
    openai: {
      language: "zh", // ISO 639-1，提升准确率与延迟
      timestampGranularities: ["word"], // 默认 segment 级；word 级会增加延迟
    },
  },
});

transcript.text; // 转写文本
transcript.segments; // 分段（含每段 text 与起止时间），仅部分模型返回
transcript.language; // 检测/指定的语言
transcript.durationInSeconds; // 音频时长，仅部分模型返回
```

### `audio` 接受的输入类型

`Uint8Array` / `ArrayBuffer` / `Buffer`（`readFile` 的结果直接传）/ base64 `string` / `URL`。

- 传 `URL` 时 SDK 会先下载：**默认上限 2 GiB**，超限抛 `DownloadError`；可用
  `download: createDownload({ maxBytes })` 调整。
- 从表单上传拿到的 `File` 要转一下：`Buffer.from(await file.arrayBuffer())`。

### OpenAI 转写 providerOptions

| 选项                     | 类型                                          | 说明                                    |
| ------------------------ | --------------------------------------------- | --------------------------------------- |
| `language`               | `string`                                      | ISO-639-1                               |
| `timestampGranularities` | `string[]`                                    | 默认 segment 级；word 级更慢            |
| `prompt`                 | `string`                                      | 风格提示 / 承接前文                     |
| `temperature`            | `number`                                      | 0–1，默认 0                             |
| `include`                | `string[]`                                    | 附加返回字段                            |
| `responseFormat`         | `'json' \| 'verbose_json' \| 'diarized_json'` |                                         |
| `chunkingStrategy`       | `'auto' \| object`                            | 服务端 VAD 分块                         |
| `streaming`              | `object`                                      | 仅流式模型（如 `gpt-realtime-whisper`） |

### 模型能力差异（选型关键）

| 模型                        | 转写 | 时长 | segments                                                    | 语言检测 | 流式 |
| --------------------------- | ---- | ---- | ----------------------------------------------------------- | -------- | ---- |
| `whisper-1`                 | ✓    | ✓    | ✓                                                           | ✓        | ✗    |
| `gpt-4o-mini-transcribe`    | ✓    | ✗    | ✗                                                           | ✗        | ✗    |
| `gpt-4o-transcribe`         | ✓    | ✗    | ✗                                                           | ✗        | ✗    |
| `gpt-4o-transcribe-diarize` | ✓    | ✓    | ✓（含说话人，走 `result.providerMetadata.openai.segments`） | ✗        | ✗    |
| `gpt-realtime-whisper`      | —    | ✗    | ✗                                                           | ✗        | ✓    |

一句话：**要时间戳/语言检测 → `whisper-1`；只要纯文本且要更准/更快 → `gpt-4o-transcribe`（系列）。**

### 错误处理

```ts
import { NoTranscriptGeneratedError, transcribe } from "ai";

try {
  await transcribe({ model: openai.transcription("whisper-1"), audio });
} catch (error) {
  if (NoTranscriptGeneratedError.isInstance(error)) {
    console.log(error.cause, error.responses);
  } else throw error;
}
```

### 完整示例：Next.js Route Handler 接收上传并转写

```ts
// app/api/transcribe/route.ts
import { transcribe } from "ai";
import { openai } from "@ai-sdk/openai";

export async function POST(req: Request) {
  const form = await req.formData();
  const file = form.get("audio") as File;
  if (!file) return new Response("audio file required", { status: 400 });

  const { text, language, durationInSeconds } = await transcribe({
    model: openai.transcription("whisper-1"),
    audio: Buffer.from(await file.arrayBuffer()),
    providerOptions: { openai: { language: "zh" } },
  });

  return Response.json({ text, language, durationInSeconds });
}
```

### 流式转写（实验性）

需要 `gpt-realtime-whisper` 这类实时模型，适用场景：麦克风实时字幕。

```ts
import { experimental_streamTranscribe as streamTranscribe } from "ai";

const result = streamTranscribe({
  model: openai.transcription("gpt-realtime-whisper"),
  audio: stream, // 音频流
});

for await (const part of result.fullStream) {
  // part.type: 'transcript-delta' | 'transcript-partial' | 'transcript-final'
  process.stdout.write(part.type === "transcript-delta" ? part.delta : "");
}
```

注意：`fullStream` 只能消费一次；该 API 在 v7 仍为实验性。AI Gateway 场景下可用
`gateway.experimental_transcription.getToken` 给前端签发短期 token，让浏览器直连。

---

## 三、走 Vercel AI Gateway（不想直接管 OpenAI key 时）

```ts
import { generateSpeech, transcribe } from "ai";
import { gateway } from "@ai-sdk/gateway";

const speech = await generateSpeech({
  model: gateway.speechModel("openai/tts-1"), // Gateway TTS 目前只支持 openai/tts-1 和 openai/tts-1-hd
  text: "…",
  voice: "alloy",
  outputFormat: "mp3",
});

const t = await transcribe({
  model: gateway.transcriptionModel("openai/whisper-1"),
  audio,
});
```

Gateway 限制：TTS 音频以 base64 JSON 返回（**不支持流式**）；转写支持 `openai/whisper-1` 等 OpenAI
模型。认证读 `AI_GATEWAY_API_KEY`。

---

## 四、常见坑（写代码前过一遍）

1. **导入名写错**是最常见错误：v7 里 `experimental_transcribe` 只是 deprecated alias；v6
   里没有稳定名 `transcribe`。不确定版本时用 `experimental_x as x` 别名写法（v7 下会提示 deprecated
   但能跑）。
2. `openai.speech(...)` 与 `openai.transcription(...)` 是两个独立工厂方法，别写成 `openai.tts(...)`
   / `openai.whisper(...)`。
3. **被忽略的参数不报错**：统一进 `result.warnings`，生产代码建议
   `if (result.warnings.length) console.warn(result.warnings)`。
4. `instructions` 对 `tts-1` / `tts-1-hd` 无效（文档明确说明不生效），要风格控制必须用
   `gpt-4o-mini-tts`。
5. `segments` / `durationInSeconds` / `language`
   只由部分转写模型返回，代码里当可选字段处理（见模型能力表）。
6. word 级时间戳会显著增加转写延迟，字幕类需求优先 segment 级。
7. `audio` 传 `URL` 时默认 2 GiB 下载上限；大文件先在业务侧下载再传 `Uint8Array`。
8. TTS 和普通转写都是**一次性返回**，没有流式；只有转写有实验性流式 API。
9. 两个错误类的名字与 `.isInstance()` 判断法（不要用 `instanceof`，跨包/多版本场景不可靠）。

## 五、参考来源（2026-10-13 核对）

- <https://ai-sdk.dev/docs/ai-sdk-core/speech> — Speech 指南
- <https://ai-sdk.dev/docs/reference/ai-sdk-core/generate-speech> — generateSpeech 参数/返回值
- <https://ai-sdk.dev/docs/ai-sdk-core/transcription> — 转写指南
- <https://ai-sdk.dev/v5/docs/reference/ai-sdk-core/transcribe> — transcribe 参考（v5 命名）
- <https://ai-sdk.dev/providers/ai-sdk-providers/openai> — OpenAI provider：speech/transcription
  模型与 providerOptions
- <https://ai-sdk.dev/docs/migration-guides/migration-guide-7-0> — v6→v7：`experimental_*` 转正为
  `transcribe` / `generateSpeech`
- <https://vercel.com/docs/ai-gateway/getting-started/speech> — Gateway 语音快速上手
- <https://vercel.com/docs/ai-gateway/modalities/speech-to-text> — Gateway 转写（含流式与 token）
