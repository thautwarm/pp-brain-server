// DeepSeek here is a protocol rather than a provider or a model!

import type { OpenAICompatibleCompletionProviderOptions } from "@ai-sdk/openai-compatible";
import { z } from "zod";
import type { Credential } from "../../auth.ts";
import type { LanguageModel, LanguageModelCallOptions } from "../abstraction/index.ts";
import { createOpenAICompatibleWithOgg } from "./openai-compatible-ogg.ts";

type CreateModelOptions<Args> = {
  /**
   * 模型名。同一个 OpenAI 兼容端点上挂什么模型是**部署**的事，所以由调用方说，
   * adapter 不猜——之前就是因为没人给，整条链连 `.chatModel()` 都无从调用。
   */
  model: string;
  args: Args;
  credential: Credential;
  fetch?: typeof fetch;
  headers?: Record<string, string>;
};

export const parameters = z.object({
  temperature: z.number().min(0).max(2).optional(),
  level: z.enum(["off", "low", "high", "max"]).optional(),
  context: z
    .number()
    .int()
    .min(1024 * 16)
    .max(1_000_000)
    .optional(),
  maxOutputTokens: z.number().int().min(4096).max(384_000).optional(),
});

export function prepare(options: CreateModelOptions<z.infer<typeof parameters>>): {
  generation: LanguageModelCallOptions;
  providerOptions: OpenAICompatibleCompletionProviderOptions;
  languageModel: LanguageModel;
} {
  const { model, args, credential, fetch, headers } = options;
  const providerOptions: OpenAICompatibleCompletionProviderOptions = {};
  const generation: LanguageModelCallOptions = {};
  generation.maxOutputTokens = args.maxOutputTokens;

  // **`.chatModel(model)` 一定要调。** `createOpenAICompatible(...)` 返回的是 provider，
  // 不是 model——它俩 `specificationVersion` 都是 "v4"，但 provider 上没有 `provider` / `modelId` /
  // `doStream`，直接丢给 AI SDK 会在 `resolvedModel.provider.split(".")` 上炸
  // （TypeError: Cannot read properties of undefined (reading 'split')）。
  //
  // 用我们自己的那个薄包装（`openai-compatible-ogg`）而不是直接用 createOpenAICompatible：
  // 后者把音频格式白名单写死成 wav/mp3，喂不进 Ogg Opus。
  //
  // 末尾那个 cast 是**名义问题**：ai@7 自带 @ai-sdk/provider@4.0.14，而这个 provider 依赖 4.0.27，
  // 两份副本的同名类型互不兼容。钉 provider 版本能消掉它，但那会牵动整个 workspace 的解析，
  // 这里就用 cast 明说"我知道，是同一个接口"。
  const languageModel = createOpenAICompatibleWithOgg(
    {
      name: "deepseek",
      apiKey: credential.auth.apiKey,
      baseURL: credential.baseURL,
      fetch,
      headers,
    },
    model,
  ) as unknown as LanguageModel;

  // default: 1.0 (https://api-docs.deepseek.com/quick_start/parameter_settings/)
  generation.temperature = args.temperature ?? 1;

  switch (args.level) {
    case "off":
      generation.reasoning = "none";
      break;
    case "high":
      generation.reasoning = "high";
      break;
    case "max":
      generation.reasoning = "xhigh";
      break;
    default:
      generation.reasoning = "provider-default";
      break;
  }
  return {
    languageModel,
    generation,
    providerOptions,
  };
}
