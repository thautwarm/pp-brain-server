/**
 * @might/audio 的公开面：语音合成（TTS）和语音转写（STT）。
 *
 * 两边都是"一次调用、一个产物"，没有流——AI SDK 的 generateSpeech / transcribe 本身
 * 就是一次性返回的，这一层不假装它们是流。实时字幕要的是实验性的 streamTranscribe，
 * 那是另一件事，这层不开。
 *
 * 跟 @might/chat 一样，只认 model / 参数 / providerOptions，不掺上层的业务概念：音频存哪、
 * 转写结果给谁，都是调用方的事。入口是命名空间，底下全是无状态函数。
 *
 * 唯一的例外是 sttModel / ttsModel：音频端点几乎都是 OpenAI 协议的自建服务，把
 * baseURL + apiKey + 模型名拼成一个模型对象这种活，固定到没必要每个调用点各写一遍，所以给两个
 * 便利工厂（见"造模型"一节）。它们只管拼，不多认任何东西。
 *
 * 公开面只放形状和类型，实现放在 implementation/ 目录，形状和这一层的命名空间对齐。
 */

import type { ProviderOptions } from "@ai-sdk/provider-utils";
import type {
  GeneratedAudioFile,
  ProviderMetadata,
  SpeechModel,
  TranscriptionModel,
  Warning,
} from "ai";

import * as implementation from "./implementation/index.ts";

// 上游公开类型
// 消费方只装本包也能拿到这些类型，不必自己再装 AI SDK。名字保持上游原名。

export type { ProviderOptions } from "@ai-sdk/provider-utils";
export type {
  GeneratedAudioFile,
  ProviderMetadata,
  SpeechModel,
  TranscriptionModel,
  Warning,
} from "ai";

// 错误

/**
 * 稳定事实，不带原始输入、凭据、header 或上游 cause。
 *
 * 底层的真实异常走 Error 标准的 cause 通道：本类型保持可序列化、可对外，cause 只用来排查。
 *
 * 四个失败码分成两类：`*-failed` 是这次调用没成（网络、凭据、provider 挂了），
 * 重试可能有用；`no-*-generated` 是调用成了但模型没产出东西（空文本、静音音频），
 * 同样的输入再来一次也一样。
 */
export type AudioErrorData =
  | { readonly code: "invalid-input"; readonly field?: string; readonly detail?: string }
  | { readonly code: "speech-failed" }
  | { readonly code: "no-speech-generated" }
  | { readonly code: "transcription-failed" }
  | { readonly code: "no-transcript-generated" }
  | { readonly code: "aborted" }
  // 下面这些来自本地转码（convertToOggOpus），跟模型调用无关。
  | { readonly code: "ffmpeg-missing"; readonly detail?: string }
  | { readonly code: "too-large"; readonly bytes: number; readonly limit: number }
  | { readonly code: "output-too-large"; readonly limit: number }
  | { readonly code: "timed-out"; readonly timeoutMs: number }
  | { readonly code: "transcode-failed"; readonly exitCode?: number };

export type AudioErrorCode = AudioErrorData["code"];

/**
 * 本包唯一的异常类型。
 *
 * `data` 是稳定事实，可以对外；`cause` 只用于排查，可能包着原始输入甚至凭据，
 * 别序列化它，也别直接回给终端用户。
 */
export class AudioError extends Error {
  override readonly name = "AudioError";
  readonly data: AudioErrorData;

  constructor(data: AudioErrorData, options?: { readonly cause?: unknown }) {
    super(data.code, options);
    this.data = data;
  }

  get code(): AudioErrorCode {
    return this.data.code;
  }

  /** 哪一项输入不合法；只有 `invalid-input` 带这个。 */
  get field(): string | undefined {
    return "field" in this.data ? this.data.field : undefined;
  }
}

// 合成

/**
 * 合成出来的语音：音频本体，加上它是怎么做出来的。
 *
 * `audio` 直接用上游的 GeneratedAudioFile，不重新包一层，因为它的 base64 / uint8Array
 * 是**惰性**的：用哪个才算哪个。一段 10MB 的音频转成 base64 是 13MB 的字符串，
 * 只往文件里写的人不该为此付钱。
 */
export interface Speech {
  readonly audio: GeneratedAudioFile;
  /** 我们传进去的那个模型的标识，供记账和排查；不是 provider 回报的。 */
  readonly modelId?: string;
  /**
   * 被忽略的选项在这里，不在异常里。
   *
   * 模型不支持的参数不会让调用失败，只会静默降级——比如给 tts-1 传 instructions。
   * 这是上游的既定行为，所以生产代码该看一眼这个字段。
   */
  readonly warnings: readonly Warning[];
  /** provider 自己的附加数据；上游保证有这个字段，可能是空对象。 */
  readonly providerMetadata: ProviderMetadata;
}

/**
 * 合成语音的选项，对 AI SDK 的 generateSpeech。字段名保持上游原名。
 *
 * `voice` / `speed` / `instructions` 能不能生效由模型决定：instructions 只有
 * gpt-4o-mini-tts 认。provider 专属的开关走 providerOptions，例如 OpenAI 的
 * `{ openai: { speed: 1.2 } }`（和顶层 speed 是一回事，别两边都写）。
 */
export interface SpeechOptions {
  readonly model: SpeechModel;
  readonly text: string;
  /**
   * 音色。OpenAI 认 alloy / ash / ballad / coral / echo / fable / onyx / nova /
   * sage / shimmer / verse。
   */
  readonly voice?: string;
  /**
   * 输出格式。要 Ogg Opus 就写 `"opus"`，**别写 `"ogg"`**：OpenAI 认的是
   * mp3 / opus / aac / flac / wav / pcm，其余的值会被它打回并静默降级成 mp3（进 warnings）。
   *
   * 产物的 mediaType / format 是**从返回的字节嗅探**出来的，不是按你请求的格式标的：
   * OpenAI 的 opus 是 Ogg 封装，所以拿到的会是 audio/ogg。别拿 format 去反推你请求了什么。
   */
  readonly outputFormat?: "mp3" | "wav" | (string & {});
  /** 语气/风格指导，只有 gpt-4o-mini-tts 一类模型支持。 */
  readonly instructions?: string;
  readonly speed?: number;
  /** ISO 639-1（"zh" / "en"…）或 "auto"；provider 支持度不一。 */
  readonly language?: string;
  readonly providerOptions?: ProviderOptions;
  readonly maxRetries?: number;
  readonly abortSignal?: AbortSignal;
  readonly headers?: Record<string, string>;
}

// 转写

export interface TranscriptSegment {
  readonly text: string;
  readonly startSecond: number;
  readonly endSecond: number;
}

/**
 * 一份转写：文字，加上模型愿意说的那些附带信息。
 *
 * `language` / `durationInSeconds` / `segments` 只有部分模型给（whisper-1 给全，
 * gpt-4o-transcribe 系列只给文字），所以当可选字段用，别假设一定有。
 */
export interface Transcript {
  readonly text: string;
  /** 分段；模型不给时是空数组，不是 undefined。 */
  readonly segments: readonly TranscriptSegment[];
  readonly language?: string;
  readonly durationInSeconds?: number;
  readonly modelId?: string;
  readonly warnings: readonly Warning[];
  readonly providerMetadata: ProviderMetadata;
}

/**
 * 转写的输入：二进制、base64 字符串（含 data URL），或者一个 URL。
 *
 * 传 URL 时上游会先下载再转写，两点要注意：**默认上限 2 GiB**，而且下载在重试之外——
 * 下载失败不会重试。大文件自己下好了再传 Uint8Array。
 *
 * 媒体类型由上游**按字节嗅探**，没得选（这层不暴露 mediaType 参数）。Ogg 容器认得出来
 * （"OggS" 开头 → audio/ogg，OpenAI 那边收到的是 audio.ogg），裸 Opus 认不出来——
 * 嗅探失败兜底成 audio/wav，那标签就是错的。手上有裸 Opus 先用 ffmpeg 封装成 Ogg。
 */
export type AudioInput = Uint8Array | ArrayBuffer | string | URL;

/**
 * 转写的选项，对 AI SDK 的 transcribe。字段名保持上游原名。
 *
 * OpenAI 那些开关（language / timestampGranularities / prompt / temperature /
 * responseFormat / chunkingStrategy）都在 providerOptions.openai 里，这层不做转译——
 * 说了算的是 provider，不是我们。word 级时间戳会明显拖慢速度，字幕优先用 segment 级。
 */
export interface TranscriptionOptions {
  readonly model: TranscriptionModel;
  readonly audio: AudioInput;
  readonly providerOptions?: ProviderOptions;
  readonly maxRetries?: number;
  readonly abortSignal?: AbortSignal;
  readonly headers?: Record<string, string>;
}

// 造模型

/**
 * 造 stt / tts 模型要的东西：一个 OpenAI 兼容的端点，加上模型名。
 *
 * 端点就是 OpenAI 那套形状——`/audio/transcriptions`、`/audio/speech` 挂在 baseURL 底下，
 * 所以 baseURL 通常要带 `/v1`。apiKey 会变成 `Authorization: Bearer`；本地服务不校验的话，
 * 给个非空字符串就行。模型名不限于 OpenAI 自己的那些，对面认什么就写什么。
 */
export interface ModelOptions {
  /** 端点根地址，例如 `http://192.0.2.113:8082/v1`。 */
  readonly baseURL: string;
  /** 会被发成 `Authorization: Bearer <apiKey>`。 */
  readonly apiKey: string;
  /** 模型名，例如 `whisper-1` / `tts-1`。 */
  readonly model: string;
  readonly headers?: Record<string, string>;
  /** 换掉 fetch：测试，或者要塞中间件。 */
  readonly fetch?: typeof fetch;
}

// 入口

/**
 * AudioAgent：这一层的全部入口，一个命名空间，不是一个能被创建的对象。
 *
 * 一半是**调模型**：`synthesize` / `transcribe` 各对上游的一个函数，都返回 Promise——
 * 没有流，也就没有 ChatAgent 那种 `{ chunks, result, abort }` 的运行对象。取消走
 * abortSignal：传进来的 signal 已经 aborted 时，我们不发请求，直接以 `aborted` 失败。
 *
 * 另一半是**造模型**：`sttModel` / `ttsModel` 从一个 OpenAI 兼容的端点造出模型对象，
 * 交给上面那两个用。
 */
export const AudioAgent = {
  /** 合成语音：一段文字进，一段音频出。 */
  synthesize(options: SpeechOptions): Promise<Speech> {
    return implementation.synthesize(options);
  },

  /** 转写语音：一段音频进，一份文字出。 */
  transcribe(options: TranscriptionOptions): Promise<Transcript> {
    return implementation.transcribe(options);
  },

  /** 造一个转写（STT）模型。 */
  sttModel(options: ModelOptions): TranscriptionModel {
    return implementation.sttModel(options);
  },

  /** 造一个合成（TTS）模型。 */
  ttsModel(options: ModelOptions): SpeechModel {
    return implementation.ttsModel(options);
  },
};

// 本地转码

/**
 * 跑这一趟用哪条路。**这是部署决定的事**：不给就整条看环境变量（MIGHT_FFMPEG_RUNNER），
 * 所以生产的调用点通常不出现它。
 *
 * - `wasm`（默认）原地跑 WASM 编解码器（libopus + Ogg muxer）：不要进程、不要容器、不要
 *   ffmpeg，比另外几条还快；但它只认装了 MIT 解码器的格式——WebM 和 Ogg Opus。
 *   **默认路会自己兜底**：认不出的格式（mp4/AAC、mp3、wav……）自动换 `build` 再跑一次。
 * - `build` 自建容器：用自带的 Dockerfile 构建 alpine + ffmpeg，构建一次之后复用。什么都认，
 *   但要容器运行时
 * - `image` 指定镜像：同上，镜像名不给看 MIGHT_FFMPEG_IMAGE；本地没有就报错，**绝不隐式拉取**
 * - `direct` 不用容器，直接跑宿主机的 ffmpeg；路径不给看 MIGHT_FFMPEG_BIN，再不给找 PATH
 * - `http` 丢给一个 HTTP 服务跑；地址不给看 MIGHT_FFMPEG_URL（契约见 README）
 *
 * **显式点了 kind 就不替它兜底**：选了哪条就是哪条，连不上/认不出都直接失败，
 * 不会悄悄换成另一条（`build` / `image` 找不到容器运行时也不会退化成 `direct`）。
 */
export type RunnerOptions =
  | { readonly kind: "build"; readonly engine?: string }
  | {
      readonly kind: "image";
      /** 默认 mwader/static-ffmpeg:latest（它的 entrypoint 就是 ffmpeg）。 */
      readonly image?: string;
      readonly engine?: string;
    }
  | { readonly kind: "direct"; readonly bin?: string }
  | { readonly kind: "http"; readonly url?: string }
  | { readonly kind: "wasm" };

export interface RunnerStatus {
  readonly kind: "container" | "direct" | "http" | "wasm" | "unavailable";
  /** container 是镜像名，direct 是 ffmpeg 路径，http 是服务地址。 */
  readonly target?: string;
  /** 容器运行时的版本。 */
  readonly engineVersion?: string;
  /** kind 为 unavailable 时说明为什么。 */
  readonly detail?: string;
}

/**
 * 转码参数。**全都可以不给**，不给就是下面写的默认值——默认值就是产品：这套输出是给下游
 * （我们的服务）认的，它只有一种口味。
 *
 * 真要用的时候，是"这次这个文件特殊"这种理由，不是"每个调用点都顺手调一下"。
 */
export interface TranscodeParams {
  /** 目标码率 kbps，默认 32。语音的甜点区（16 发闷，48 往上听不出更多）。 */
  readonly bitrateKbps?: number;
  /** 采样率，默认 48000（Opus 的原生采样率）。 */
  readonly sampleRate?: number;
  /** 声道数，默认 1（语音本来就一个声道，立体声源会先合并）。 */
  readonly channels?: number;
  /** 超过这个时长的部分**截断**（`-t` 的语义，不是报错），默认 600 秒。 */
  readonly maxDurationSeconds?: number;
  /** 墙钟超时 ms，到点杀进程并杀容器，默认 60000。 */
  readonly timeoutMs?: number;
  /** 输入字节上限，默认 25 MB（跟 OpenAI 转写接口的限制对齐）。 */
  readonly maxInputBytes?: number;
  /** 输出字节上限，默认 32 MB。 */
  readonly maxOutputBytes?: number;
}

/** 能存下来的音频：原始字节，或者我们自己的 Speech 里那个 `speech.audio`。 */
export type SaveableAudio = Uint8Array | { readonly uint8Array: Uint8Array };

/**
 * AudioHelper：不碰模型、只碰字节和文件的那一层。跟 AudioAgent 一样是个命名空间，
 * 底下全是无状态函数。
 */
export const AudioHelper = {
  /**
   * 任意常见音频 → Ogg Opus。给外面进来的、格式不确定的音频用。
   *
   * 我们自己的 TTS 出来的已经是 Ogg Opus（`outputFormat: "opus"`），别走这里——
   * 转码是有损的，能不做就不做。这里进来的每一条都会被重编一次。
   *
   * 输入是字节不是路径：走管道，不落临时文件。因为**按扩展名识别格式**正是把播放列表类
   * 攻击放进来的一半原因，而不落盘就没有扩展名这回事。
   *
   * 安全边界是两层的：参数层（`-protocol_whitelist pipe` 关掉所有跳转协议、限时长、
   * 封顶字节数、墙钟超时）永远在；执行层（禁网 + cgroup 限额 + 只读根 + 非 root）
   * 取决于 runner：`build` / `image` 有，`direct` 和 `http` 没有。
   * **参数层挡不住 ffmpeg 自身的解析漏洞，只有执行层能。**
   */
  convertToOggOpus(
    input: Uint8Array,
    runner?: RunnerOptions,
    params?: TranscodeParams,
  ): Promise<Uint8Array> {
    return implementation.convertToOggOpus(input, runner, params);
  },

  /**
   * 查现在会走哪条路，以及为什么。**只看路，不涉及转码**。
   *
   * **进程启动时断言一次**，别等第一个用户请求才发现生产环境没跑在容器里：
   *
   * ```ts
   * const status = await AudioHelper.inspectRunner();
   * if (status.kind !== "container" && status.kind !== "http") {
   *   throw new Error(`ffmpeg 没跑在沙箱里：${status.kind} ${status.detail ?? ""}`);
   * }
   * ```
   *
   * 注意 http 这条路这里**只查得到配置，查不到那边到底有没有沙箱**——它报 http 是"配好了"，
   * 不是"安全了"。
   */
  inspectRunner(runner?: RunnerOptions): Promise<RunnerStatus> {
    return implementation.inspectRunner(runner);
  },

  /**
   * 把音频写到文件。目录不存在就顺手建出来（`saveAudioFile(bytes, "cache/a.ogg")` 不该因为
   * 少了 cache/ 就失败）。
   *
   * **只在 Node 里能用**：`node:fs` 是动态加载的，浏览器打包时碰不到它，但真调用会报错。
   *
   * 失败抛的是文件系统自己的错误（ENOENT / EACCES …），不包成 AudioError——那是模型和
   * 转码的异常类型，文件的事就用文件的话说。
   */
  async saveAudioFile(input: SaveableAudio, path: string): Promise<void> {
    return implementation.saveAudioFile(input, path);
  },

  /**
   * 把音频读出来，给转写或者转码用。
   *
   * **只在 Node 里能用**，同上。返回的就是普通字节，交回去给 `AudioAgent.transcribe` 正好。
   */
  async loadAudioFile(path: string): Promise<Uint8Array> {
    return implementation.loadAudioFile(path);
  },

  /**
   * 音频 → base64 字符串，**不带 `data:` 前缀**。
   *
   * 给要进 JSON 的地方用（比如 history）：字节塞不进 JSON，base64 是唯一的选择。
   * 要 data URL 自己加前缀，这一层不猜容器类型。`speech.audio` 那种包了一层的对象也直接收
   * （跟 `saveAudioFile` 一样）。
   */
  toBase64(input: SaveableAudio): string {
    return implementation.toBase64(input);
  },
};
