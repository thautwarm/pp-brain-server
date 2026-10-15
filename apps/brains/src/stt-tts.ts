import type { SpeechModel, TranscriptionModel } from "@might/audio";
import { AudioAgent, AudioHelper } from "@might/audio";

/**
 * STT / TTS：两个写死的 OpenAI 兼容端点。
 *
 * **模型是惰性建的，不在模块顶层。** 因为 env 的加载时机：main.ts 里任何加载 `.env` 的动作
 * 都跑在**静态 import 之后**（import 会提升），顶层建模型会拿着空 baseURL 造出一个永远打不通
 * 的端点——而且不报错，只在第一次请求时以看不懂的方式失败。
 */
let stt: TranscriptionModel | undefined;
let tts: SpeechModel | undefined;

function sttModel(): TranscriptionModel {
  stt ??= AudioAgent.sttModel({
    apiKey: process.env.STT_API_KEY ?? "",
    baseURL: process.env.STT_API_BASE_URL ?? "",
    model: "qwen-asr",
  });
  return stt;
}

function ttsModel(): SpeechModel {
  tts ??= AudioAgent.ttsModel({
    apiKey: process.env.TTS_API_KEY ?? "",
    baseURL: process.env.TTS_API_BASE_URL ?? "",
    model: "moss-tts",
  });
  return tts;
}

export async function callTranscript(
  audio: Uint8Array,
  options: { signal?: AbortSignal },
): Promise<{ text: string }> {
  const transcript = await AudioAgent.transcribe({
    model: sttModel(),
    audio,
    abortSignal: options.signal,
    maxRetries: 3,
  });

  return { text: transcript.text };
}

/**
 * 合成语音。**出来的一律是 Ogg Opus**——规格 §4 定死了下行格式，客户端只认它。
 *
 * `outputFormat: "opus"` 是请服务端回 Ogg，但产物格式是**按返回的字节嗅探**出来的：服务端
 * 无视这个参数时不会报错，只会静默给一段 mp3/wav。所以这里核一次，不是 Ogg 就本地转。
 * 转码默认 48kHz，规格要 24kHz，所以显式给。
 */
export async function callVoiceGen(
  text: string,
  voice: string,
  options: { signal?: AbortSignal },
): Promise<{ audio: Uint8Array }> {
  const speech = await AudioAgent.synthesize({
    model: ttsModel(),
    text,
    voice,
    outputFormat: "opus",
    abortSignal: options.signal,
    maxRetries: 3,
  });

  if (speech.audio.format === "ogg") return { audio: speech.audio.uint8Array };

  const ogg = await AudioHelper.convertToOggOpus(speech.audio.uint8Array, undefined, {
    sampleRate: 24000,
  });
  return { audio: ogg };
}
