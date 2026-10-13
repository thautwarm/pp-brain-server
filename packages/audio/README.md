# @might/audio

语音的事实层：**合成**（TTS）、**转写**（STT），外加**任意音频 → Ogg Opus** 的转码。

- 一次调用、一个产物，没有流。
- 失败归一成一种异常 `AudioError`，带稳定 code（清单见 `AudioErrorData`）；原始异常走 `cause`。
- 模型实例、`providerOptions` 由调用方解析好，原样交给这一层。要 Ogg Opus 就写 `outputFormat: "opus"`。
- 两个命名空间：`AudioAgent` 管模型，`AudioHelper` 管字节和文件。底下全是无状态函数，没有实例和配置。

上游依赖锁 `ai@7.0.101`。

## 最小用法

```ts
import { AudioAgent, AudioHelper } from "@might/audio";

const speech = await AudioAgent.synthesize({
  model, // 模型从哪来由调用方决定，这一层不关心
  text: "你好",
  voice: "alloy",
  outputFormat: "opus",
});
await AudioHelper.saveAudioFile(speech.audio, "speech.ogg");

const transcript = await AudioAgent.transcribe({
  model: transcriptionModel,
  audio: await AudioHelper.loadAudioFile("speech.ogg"),
});
transcript.text;
```

## 结果

`speech.audio` 是上游的 `GeneratedAudioFile`：`uint8Array` 写文件或塞进 `Response`，`base64` 给 data URL，
两个表示是惰性的，用哪个才算哪个。

`transcript` 的 `segments` / `language` / `durationInSeconds` 可能没有——模型不给就是空数组 / `undefined`，
别假设一定有。

## 转码：任意音频 → Ogg Opus

```ts
const ogg = await AudioHelper.convertToOggOpus(uploadBytes);
```

后面两个参数一般都不用给：跑哪条路（有 `build` / `image` / `direct` / `http` 四种，默认 build，
部署用 `MIGHT_FFMPEG_RUNNER` 选，地址走 `MIGHT_FFMPEG_IMAGE` / `MIGHT_FFMPEG_BIN` / `MIGHT_FFMPEG_URL`）
和转码参数（默认 32 kbps / 单声道 / 48 kHz，字段见 `TranscodeParams`）。

```ts
await AudioHelper.convertToOggOpus(bytes);                            // 看环境变量
await AudioHelper.convertToOggOpus(bytes, { kind: "direct" });        // 明确要哪条路
await AudioHelper.convertToOggOpus(bytes, undefined, { bitrateKbps: 16 });
```

`build` / `image` 在容器里跑（禁网 + cgroup 限额 + 只读根 + 非 root），`direct` 和 `http` **没有沙箱**。
生产启动时断言一次：

```ts
const status = await AudioHelper.inspectRunner();
if (status.kind !== "container" && status.kind !== "http") {
  throw new Error(`ffmpeg 没跑在沙箱里：${status.kind} ${status.detail ?? ""}`);
}
```

`http` 那条路的契约，对面照这个实现就行：

```
POST <url>    multipart/form-data
  文本段：bitrateKbps / sampleRate / channels / maxDurationSeconds
  文件段：audio（application/octet-stream，不带扩展名）
→ 2xx 的 body 就是 Ogg Opus 字节
```

那些默认值和加固参数怎么来的：[docs/audio-ogg-opus-notes.md](../../docs/audio-ogg-opus-notes.md)。

## 存取音频

```ts
await AudioHelper.saveAudioFile(speech.audio, "cache/abc.ogg"); // Speech 里的那个对象直接给
await AudioHelper.saveAudioFile(bytes, "cache/abc.ogg");        // 原始字节也行
const bytes = await AudioHelper.loadAudioFile("cache/abc.ogg");
```

目录不存在会顺手建出来。只在 Node 里能用（`node:fs` 是动态加载的）。失败抛文件系统自己的错误，
不包成 `AudioError`。

## 不做什么

- 不做流式。实时字幕要 `streamTranscribe` 加 `gpt-realtime-whisper`，那是另一件事，这层不开。
- 转码不管文件的来路和去处：给字节、还字节，不存不清理。
- 不定重试策略：`maxRetries` 原样交给上游。
- 不转译 provider 参数：OpenAI 的开关怎么写就怎么传。
