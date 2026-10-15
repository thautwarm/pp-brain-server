/**
 * 造模型：从一个 OpenAI 兼容的端点（baseURL + apiKey）和模型名，做出 stt / tts 模型对象。
 *
 * 用 @ai-sdk/openai 而不是 @ai-sdk/openai-compatible：后者只有 chat / completion /
 * embedding / image，**根本没有 speech 和 transcription**。OpenAI 自己那套 provider 讲的就是
 * 这个协议，baseURL 指过去就是"OpenAI 兼容"——whisper 那一类自建服务照单全收。
 *
 * 这一层不存配置：每次调用各造一个 provider，模型对象自己就是配置。
 */
import { createOpenAI } from "@ai-sdk/openai";
import type { SpeechModel, TranscriptionModel } from "ai";

import type { ModelOptions } from "../index.ts";

/** 造一个转写（STT）模型。 */
export function sttModel(options: ModelOptions): TranscriptionModel {
  const { baseURL, apiKey, model, headers, fetch } = options;
  return createOpenAI({ baseURL, apiKey, headers, fetch }).transcription(model);
}

/** 造一个合成（TTS）模型。 */
export function ttsModel(options: ModelOptions): SpeechModel {
  const { baseURL, apiKey, model, headers, fetch } = options;
  return createOpenAI({ baseURL, apiKey, headers, fetch }).speech(model);
}
