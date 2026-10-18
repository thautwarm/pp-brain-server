import type { TranscriptionModel } from "@might/audio";
import { AudioAgent } from "@might/audio";

/**
 * STT / TTS：两个写死的 OpenAI 兼容端点。
 *
 * **模型是惰性建的，不在模块顶层。** 因为 env 的加载时机：main.ts 里任何加载 `.env` 的动作
 * 都跑在**静态 import 之后**（import 会提升），顶层建模型会拿着空 baseURL 造出一个永远打不通
 * 的端点——而且不报错，只在第一次请求时以看不懂的方式失败。
 */
let stt: TranscriptionModel | undefined;

function sttModel(): TranscriptionModel {
  stt ??= AudioAgent.sttModel({
    apiKey: process.env.STT_API_KEY ?? "",
    baseURL: process.env.STT_API_BASE_URL ?? "",
    // 模型名走环境变量：换模型是部署的事，不该改代码重建镜像。
    model: process.env.STT_MODEL ?? "qwen-asr",
  });
  return stt;
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
