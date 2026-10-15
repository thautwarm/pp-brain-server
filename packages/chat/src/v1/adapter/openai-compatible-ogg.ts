/**
 * OpenAI 兼容的 chat 模型，比 `@ai-sdk/openai-compatible` 多认一个音频格式：**ogg**。
 *
 * 为什么要它：那个包把音频格式白名单写死在 `getAudioFormat` 里，只有 wav / mp3(mpeg)，
 * `audio/ogg` 直接落到 default 抛 `UnsupportedFunctionalityError`。而我们的音频**全是 Ogg
 * Opus**（规格 §4 上行就是 ogg），服务端也认 ogg —— 卡住的只有 SDK 这一层。
 * （上游到 3.0.69 都没加，所以等版本没用。）
 *
 * 做法是两道，**都只碰"声明"、不碰字节**：
 *
 *   ① 交给底层之前，把 prompt 里 `audio/ogg` 的 file part 声明成 `audio/wav` —— 骗过那张
 *      白名单，让它照常产出 `input_audio` 而不是抛错。
 *   ② 请求体建好之后，用包自己暴露的 `transformRequestBody`（它是在 `getArgs` **之后**套的，
 *      看得见最终的 messages）把 `input_audio.format` 从 `"wav"` 改回真相 `"ogg"`。
 *
 * 服务端最后收到的就是 `{ type: "input_audio", input_audio: { data, format: "ogg" } }`，
 * 跟手写请求一模一样。
 *
 * ⚠️ **这个模型只适合收 Ogg Opus。** ② 会把请求体里所有 `input_audio.format === "wav"` 都
 * 改成 `"ogg"`（因为 ① 把 ogg 声明成了 wav，这里没法再区分真假）。要往同一个模型里塞真 WAV，
 * 得另外加标记，别直接复用这个函数。
 */

import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import type {
  LanguageModelV4,
  LanguageModelV4CallOptions,
  LanguageModelV4Message,
} from "@ai-sdk/provider";

export interface OggChatModelOptions {
  /** provider 名。它同时是 `providerOptions` 的命名空间，别随手改。 */
  readonly name: string;
  readonly baseURL: string;
  readonly apiKey?: string;
  readonly headers?: Record<string, string>;
  readonly fetch?: typeof fetch;
}

/** 造一个认 `audio/ogg` 的 OpenAI 兼容 chat 模型。其余行为与 `createOpenAICompatible` 一致。 */
export function createOpenAICompatibleWithOgg(
  options: OggChatModelOptions,
  modelId: string,
): LanguageModelV4 {
  const base = createOpenAICompatible({
    name: options.name,
    baseURL: options.baseURL,
    apiKey: options.apiKey,
    headers: options.headers,
    fetch: options.fetch,
    transformRequestBody: withOggAudioFormat,
  }).chatModel(modelId);

  // 只包这一层：其余一律转发。`specificationVersion` / `provider` / `modelId` 照原样透出来，
  // 别在这里另起名字 —— 上层（AI SDK）会拿它们做判别和记账。
  return {
    specificationVersion: base.specificationVersion,
    provider: base.provider,
    modelId: base.modelId,
    supportedUrls: base.supportedUrls,
    doGenerate: (callOptions) => base.doGenerate(declareOggAsWav(callOptions)),
    doStream: (callOptions) => base.doStream(declareOggAsWav(callOptions)),
  };
}

/** ① 把 prompt 里 `audio/ogg` 的 file part 声明成 `audio/wav`（字节不动）。 */
function declareOggAsWav(options: LanguageModelV4CallOptions): LanguageModelV4CallOptions {
  const prompt = options.prompt.map((message) => {
    // 只有 user / assistant 的 content 是 part 数组；system 是 string、tool 是工具结果，都没有音频。
    if (message.role !== "user" && message.role !== "assistant") return message;

    return {
      ...message,
      content: message.content.map((part) =>
        part.type === "file" && part.mediaType.startsWith("audio/ogg")
          ? { ...part, mediaType: "audio/wav" }
          : part,
      ),
      // 这里只改了 mediaType，形状没动；user / assistant 两个成员合并后 TS 追不出精确的那一支，
      // 所以在收口处说明一次。
    } as LanguageModelV4Message;
  });

  return { ...options, prompt };
}

/** ② 请求体建好后把 `input_audio.format` 从 `"wav"` 改回 `"ogg"`。见文件头 ⚠️。 */
function withOggAudioFormat(body: Record<string, unknown>): Record<string, unknown> {
  const messages = body["messages"];
  if (!Array.isArray(messages)) return body;

  for (const message of messages as Array<Record<string, unknown>>) {
    const content = message["content"];
    if (!Array.isArray(content)) continue;

    for (const part of content as Array<Record<string, unknown>>) {
      const audio = part["input_audio"] as Record<string, unknown> | undefined;
      if (part["type"] === "input_audio" && audio?.["format"] === "wav") {
        audio["format"] = "ogg";
      }
    }
  }
  return body;
}
