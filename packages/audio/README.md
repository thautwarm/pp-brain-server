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

后面两个参数一般都不用给：跑哪条路（默认 `wasm`，部署用 `MIGHT_FFMPEG_RUNNER` 选）和转码参数
（默认 32 kbps / 单声道 / 48 kHz，字段见 `TranscodeParams`）。

| kind | 怎么跑 | 沙箱 | 认哪些输入 |
| --- | --- | --- | --- |
| `wasm`（默认） | 原地跑 WASM 编解码器（libopus + Ogg muxer），不要进程也不要容器 | **WASM 本身就是沙箱** | WebM / Matroska（里面的 Opus、Vorbis、AAC… 都行）和 Ogg Opus |
| `build` ／ `image` | 容器里的 ffmpeg | 有（禁网 + cgroup + 只读根 + 非 root） | 什么都认 |
| `direct` | 宿主机的 ffmpeg | **没有** | 什么都认 |
| `http` | POST 给一个转码服务 | **在那边，不在这边** | 看对面 |

默认那条不用装任何外部程序：`@audio/*` 解出 PCM，libopus 编回 Ogg Opus，全程在原地，转一条 3 秒
语音约 40 ms（比 `direct` 还快，省了起进程）。

它认的输入有边界（没有 mp4 的解复用器），所以默认路会**自己兜底**：认不出的格式自动换 `build`
（容器里的 ffmpeg）再跑一次——mp4、mp3、wav 照转（实测 Safari 那种 m4a：wasm 直接拒，兜底 290 ms
转完），调用点什么都不用管；两个都没成，错误里会同时说清是哪两条路没成。

> 依赖里有 GPL：`@audio/decode-webm` 会把 `decode-aac` / `decode-ac3` / `decode-dts`（都是 GPL-2.0）
> 当普通依赖装进来，这也是为什么 Matroska 里的 AAC 现在能直接转。**这事先搁置**——项目还是私用，
> 等开源前再清：计划是自己 vendor、去掉 AAC 自己编 wasm，换 `implementation/wasm-runner.ts` 一个文件。

显式点了 kind 就不兜底——说了用哪条就是哪条。

```ts
await AudioHelper.convertToOggOpus(bytes);                            // 看环境变量
await AudioHelper.convertToOggOpus(bytes, { kind: "direct" });        // 明确要哪条路
await AudioHelper.convertToOggOpus(bytes, undefined, { bitrateKbps: 16 });
```

`wasm`（WASM 本身碰不到外面）和 `build` / `image`（容器隔离）是安全的，`direct` 和 `http`
**没有沙箱**。生产启动时断言一次：

```ts
const status = await AudioHelper.inspectRunner();
if (!["container", "http", "wasm"].includes(status.kind)) {
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
