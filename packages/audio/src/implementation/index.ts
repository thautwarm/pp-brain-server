/**
 * 实现层入口：公开面（src/index.ts）的 AudioAgent 里有什么，这里就有什么。
 *
 * 两个操作各对上游的一个函数，形状即公开面。这一层只多做三件事：挡住本地就能判死的
 * 输入、把上游各式各样的失败归一、把结果裁成事实（responses 那种带 body / headers 的
 * 原始 HTTP 细节不进事实）。
 *
 * 这里是循环引用（index → implementation → index 取 AudioError），安全的前提是实现层
 * 只在函数体里用公开面的类，不在模块顶层 new：模块求值顺序决定顶层那会儿绑定还没初始化。
 */
import { isAbortError } from "@ai-sdk/provider-utils";
import {
  generateSpeech,
  NoSpeechGeneratedError,
  NoTranscriptGeneratedError,
  // 跟我们自己的名字撞了，改在导入这一侧。
  transcribe as sdkTranscribe,
} from "ai";

import type {
  AudioInput,
  SaveableAudio,
  Speech,
  SpeechOptions,
  Transcript,
  TranscriptionOptions,
} from "../index.ts";
import { AudioError } from "../index.ts";

// 造模型（stt / tts）单独一个文件，跟上面"调模型"的两个操作分开。
export { sttModel, ttsModel } from "./openai.ts";
// 本地转码（含 http runner）全在 ffmpeg.ts 一个文件里，公开面要什么这里转出去什么。
export { convertToOggOpus, inspectRunner } from "./transcode.ts";

/**
 * 文件读写：`node:fs` 是**动态加载**的，模块求值时不碰它。浏览器打包进来也不会因为一句
 * top-level import 就炸，代价是这两个函数真被调用时会失败——它们本来就是 Node 的东西。
 */
async function fs(): Promise<typeof import("node:fs/promises")> {
  return import("node:fs/promises");
}

export async function saveAudioFile(input: SaveableAudio, path: string): Promise<void> {
  const { mkdir, writeFile } = await fs();
  const { dirname } = await import("node:path");
  const bytes = input instanceof Uint8Array ? input : input.uint8Array;
  // 目录不存在就建：写缓存的时候调用点不该先自己去 mkdir。
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, bytes);
}

export async function loadAudioFile(path: string): Promise<Uint8Array> {
  const { readFile } = await fs();
  return readFile(path);
}

/**
 * 音频 → base64 字符串，**不带 `data:` 前缀**。
 *
 * 给要进 JSON 的地方用：字节塞不进 JSON，base64 是唯一的选择。要 data URL 自己加前缀——
 * 这一层不猜容器类型（字节里是能嗅出 Ogg / mp3 的，但那件事该由一个知道自己在做什么的
 * 调用点决定，不是这里顺手加一句）。
 */
export function toBase64(input: SaveableAudio): string {
  const bytes = input instanceof Uint8Array ? input : input.uint8Array;
  return Buffer.from(bytes).toString("base64");
}

/** 合成语音：文字进，音频出。 */
export async function synthesize(options: SpeechOptions): Promise<Speech> {
  assertSpeakable(options.text);
  assertNotAborted(options.abortSignal);

  let generated: Awaited<ReturnType<typeof generateSpeech>>;
  try {
    generated = await generateSpeech({
      model: options.model,
      text: options.text,
      voice: options.voice,
      outputFormat: options.outputFormat,
      instructions: options.instructions,
      speed: options.speed,
      language: options.language,
      providerOptions: options.providerOptions,
      maxRetries: options.maxRetries,
      abortSignal: options.abortSignal,
      headers: options.headers,
    });
  } catch (cause) {
    throw speechFailure(cause, options.abortSignal);
  }

  return {
    audio: generated.audio,
    modelId: modelIdOf(options.model),
    warnings: generated.warnings,
    providerMetadata: generated.providerMetadata,
  };
}

/** 转写语音：音频进，文字出。 */
export async function transcribe(options: TranscriptionOptions): Promise<Transcript> {
  assertAudible(options.audio);
  assertNotAborted(options.abortSignal);

  let generated: Awaited<ReturnType<typeof sdkTranscribe>>;
  try {
    generated = await sdkTranscribe({
      model: options.model,
      audio: options.audio,
      providerOptions: options.providerOptions,
      maxRetries: options.maxRetries,
      abortSignal: options.abortSignal,
      headers: options.headers,
    });
  } catch (cause) {
    throw transcriptionFailure(cause, options.abortSignal);
  }

  return {
    text: generated.text,
    segments: generated.segments,
    language: generated.language,
    durationInSeconds: generated.durationInSeconds,
    modelId: modelIdOf(options.model),
    warnings: generated.warnings,
    providerMetadata: generated.providerMetadata,
  };
}

/**
 * 输入检查只做本地能判死的那几种：给 provider 一个空字符串或一个 0 字节的文件，
 * 换回来的是一句看不懂的 400，对排查没有帮助。其余（音色认不认、模型支不支持某个参数）
 * 留给 provider —— 那类问题会出现在 warnings 里，不是异常。
 */
function assertSpeakable(text: string): void {
  if (text.trim() === "") {
    throw new AudioError({ code: "invalid-input", field: "text" });
  }
}

function assertAudible(audio: AudioInput): void {
  // URL 是交给上游去下载的，长度这会儿还不知道。
  if (audio instanceof URL) return;
  const bytes = audio instanceof ArrayBuffer ? audio.byteLength : audio.length;
  if (bytes === 0) {
    throw new AudioError({ code: "invalid-input", field: "audio" });
  }
}

/**
 * 已经 aborted 的 signal 就别发请求了：调用方要的是"取消"，不是"照样打一次再取消"。
 * 上游不查这一步，它把 signal 直接交给 fetch。
 */
function assertNotAborted(abortSignal: AbortSignal | undefined): void {
  if (abortSignal?.aborted === true) {
    throw new AudioError({ code: "aborted" }, { cause: abortSignal.reason });
  }
}

/**
 * 上游失败归一。
 *
 * 判别用上游自己的判据，不猜 name 字符串也不看 message：取消有两种形态（fetch 的
 * AbortError、AbortSignal.timeout 的 TimeoutError），provider 报错会被重试包成
 * RetryError，而"没有产出"是独立的错误类。
 *
 * 还有一条：signal 已经 aborted 时，抛出来的纵使不是取消类异常，这也是取消——
 * 调用方按了取消，不该再被告知"网络错误"。
 */
function speechFailure(cause: unknown, abortSignal: AbortSignal | undefined): AudioError {
  if (abortSignal?.aborted === true || isAbortError(cause)) {
    return new AudioError({ code: "aborted" }, { cause });
  }
  if (NoSpeechGeneratedError.isInstance(cause)) {
    return new AudioError({ code: "no-speech-generated" }, { cause });
  }
  return new AudioError({ code: "speech-failed" }, { cause });
}

function transcriptionFailure(cause: unknown, abortSignal: AbortSignal | undefined): AudioError {
  if (abortSignal?.aborted === true || isAbortError(cause)) {
    return new AudioError({ code: "aborted" }, { cause });
  }
  if (NoTranscriptGeneratedError.isInstance(cause)) {
    return new AudioError({ code: "no-transcript-generated" }, { cause });
  }
  return new AudioError({ code: "transcription-failed" }, { cause });
}

/** 模型标识：给了字符串就用它，给了模型对象就取它的 modelId。跟 chat-core 同一套规矩。 */
function modelIdOf(model: SpeechOptions["model"] | TranscriptionOptions["model"]): string {
  return typeof model === "string" ? model : model.modelId;
}
