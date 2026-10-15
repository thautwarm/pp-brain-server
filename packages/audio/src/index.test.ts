import assert from "node:assert/strict";
import { test } from "node:test";

import { MockSpeechModelV4, MockTranscriptionModelV4 } from "ai/test";

import type { AudioErrorCode } from "./index.ts";
import { AudioAgent, AudioError, AudioHelper } from "./index.ts";

// SDK 自己也会把 warnings 打到 stderr；这里关掉，我们只断言它们进了返回值。
Object.assign(globalThis, { AI_SDK_LOG_WARNINGS: false });

/** 一段有 mp3 帧头的假音频，够上游嗅探出格式。 */
const MP3 = new Uint8Array([0xff, 0xfb, 0x90, 0x00]);
/** "OggS" 开头 = Ogg 容器（Ogg Opus 长这样）。 */
const OGG = new Uint8Array([0x4f, 0x67, 0x67, 0x53, 0x00, 0x02, 0x00, 0x00]);
/** 没有 Ogg 封装的裸 Opus：只有 "OpusHead" 魔数，上游认不出。 */
const BARE_OPUS = new Uint8Array([0x4f, 0x70, 0x75, 0x73, 0x48, 0x65, 0x61, 0x64]);

const RESPONSE = { timestamp: new Date(0), modelId: "test-tts" };

/** 跑一次并断言它失败成我们要的码；返回错误本身，方便接着看 cause。 */
async function failsWith(
  run: Promise<unknown>,
  code: AudioErrorCode,
  field?: string,
): Promise<AudioError> {
  try {
    await run;
  } catch (error) {
    assert.ok(error instanceof AudioError, `期望 AudioError，拿到：${String(error)}`);
    assert.equal(error.code, code);
    if (field !== undefined) assert.equal(error.field, field);
    return error;
  }
  throw new Error(`期望以 ${code} 失败，但它成功了`);
}

test("公开面：AudioAgent 的两个操作都在", () => {
  assert.equal(typeof AudioAgent.synthesize, "function");
  assert.equal(typeof AudioAgent.transcribe, "function");
  assert.equal(typeof AudioAgent.sttModel, "function");
  assert.equal(typeof AudioAgent.ttsModel, "function");
});

test("合成：音频、模型标识、providerMetadata 都拿出来", async () => {
  const model = new MockSpeechModelV4({
    provider: "test",
    modelId: "test-tts",
    doGenerate: async () => ({
      audio: MP3,
      warnings: [],
      response: RESPONSE,
      providerMetadata: { test: { voice: "alloy" } },
    }),
  });

  const speech = await AudioAgent.synthesize({ model, text: "你好", voice: "alloy" });

  assert.deepEqual(speech.audio.uint8Array, MP3);
  assert.equal(speech.audio.format, "mp3");
  assert.equal(speech.modelId, "test-tts");
  assert.deepEqual(speech.warnings, []);
  assert.deepEqual(speech.providerMetadata, { test: { voice: "alloy" } });
});

test("合成：被忽略的选项走 warnings，不走异常", async () => {
  const model = new MockSpeechModelV4({
    doGenerate: async () => ({
      audio: MP3,
      warnings: [{ type: "unsupported", feature: "instructions" }],
      response: RESPONSE,
    }),
  });

  const speech = await AudioAgent.synthesize({ model, text: "你好", instructions: "慢点" });

  assert.equal(speech.warnings.length, 1);
  assert.equal(speech.warnings[0]?.type, "unsupported");
});

test("合成：模型没产出音频 → no-speech-generated", async () => {
  const model = new MockSpeechModelV4({
    doGenerate: async () => ({
      audio: new Uint8Array(0),
      warnings: [],
      response: RESPONSE,
    }),
  });

  await failsWith(AudioAgent.synthesize({ model, text: "你好" }), "no-speech-generated");
});

test("合成：空文本本地就挡掉，不发请求", async () => {
  let called = false;
  const model = new MockSpeechModelV4({
    doGenerate: async () => {
      called = true;
      return { audio: MP3, warnings: [], response: RESPONSE };
    },
  });

  await failsWith(AudioAgent.synthesize({ model, text: "   " }), "invalid-input", "text");
  assert.equal(called, false);
});

test("合成：provider 失败 → speech-failed，原始异常留在 cause 上", async () => {
  const boom = new Error("upstream 500");
  const model = new MockSpeechModelV4({
    doGenerate: async () => {
      throw boom;
    },
  });

  // maxRetries: 0 —— 否则上游会退避重试，测试要等好几秒。
  const error = await failsWith(
    AudioAgent.synthesize({ model, text: "你好", maxRetries: 0 }),
    "speech-failed",
  );
  assert.equal(error.cause, boom);
});

test("转写：文字、分段、语言、时长都拿出来", async () => {
  const model = new MockTranscriptionModelV4({
    provider: "test",
    modelId: "test-stt",
    doGenerate: async () => ({
      text: "你好世界",
      segments: [{ text: "你好世界", startSecond: 0, endSecond: 1.5 }],
      language: "zh",
      durationInSeconds: 1.5,
      warnings: [],
      response: RESPONSE,
    }),
  });

  const transcript = await AudioAgent.transcribe({ model, audio: MP3 });

  assert.equal(transcript.text, "你好世界");
  assert.deepEqual(transcript.segments, [{ text: "你好世界", startSecond: 0, endSecond: 1.5 }]);
  assert.equal(transcript.language, "zh");
  assert.equal(transcript.durationInSeconds, 1.5);
  assert.equal(transcript.modelId, "test-stt");
});

test("转写：模型不给分段/语言/时长时，是空数组和 undefined，不是缺字段", async () => {
  const model = new MockTranscriptionModelV4({
    doGenerate: async () => ({
      text: "只有文字",
      segments: [],
      language: undefined,
      durationInSeconds: undefined,
      warnings: [],
      response: RESPONSE,
    }),
  });

  const transcript = await AudioAgent.transcribe({ model, audio: MP3 });

  assert.deepEqual(transcript.segments, []);
  assert.equal(transcript.language, undefined);
  assert.equal(transcript.durationInSeconds, undefined);
});

test("转写：模型没产出文字 → no-transcript-generated", async () => {
  const model = new MockTranscriptionModelV4({
    doGenerate: async () => ({
      text: "",
      segments: [],
      language: undefined,
      durationInSeconds: undefined,
      warnings: [],
      response: RESPONSE,
    }),
  });

  await failsWith(AudioAgent.transcribe({ model, audio: MP3 }), "no-transcript-generated");
});

test("转写：0 字节音频本地就挡掉，不发请求", async () => {
  let called = false;
  const model = new MockTranscriptionModelV4({
    doGenerate: async () => {
      called = true;
      return {
        text: "x",
        segments: [],
        language: undefined,
        durationInSeconds: undefined,
        warnings: [],
        response: RESPONSE,
      };
    },
  });

  await failsWith(
    AudioAgent.transcribe({ model, audio: new Uint8Array(0) }),
    "invalid-input",
    "audio",
  );
  assert.equal(called, false);
});

test("合成：opus 是 Ogg 封装的，所以产物的 mediaType / format 就这么标", async () => {
  const model = new MockSpeechModelV4({
    doGenerate: async () => ({ audio: OGG, warnings: [], response: RESPONSE }),
  });

  const speech = await AudioAgent.synthesize({ model, text: "你好", outputFormat: "opus" });

  assert.equal(speech.audio.mediaType, "audio/ogg");
  assert.equal(speech.audio.format, "ogg");
});

// 这条锁的是上游的字节嗅探，也就是 README 里那句"媒体类型由字节决定"：
// Ogg 认得出，裸 Opus 认不出（兜底成 wav，标签是错的）。行为变了就该改文档。
test("转写：媒体类型按字节嗅探，Ogg 认得出、裸 Opus 认不出", async () => {
  const seen: string[] = [];
  const model = new MockTranscriptionModelV4({
    doGenerate: async (options) => {
      seen.push(options.mediaType);
      return {
        text: "x",
        segments: [],
        language: undefined,
        durationInSeconds: undefined,
        warnings: [],
        response: RESPONSE,
      };
    },
  });

  await AudioAgent.transcribe({ model, audio: OGG });
  await AudioAgent.transcribe({ model, audio: BARE_OPUS });

  assert.deepEqual(seen, ["audio/ogg", "audio/wav"]);
});

test("取消：signal 已经 aborted → 直接 aborted，不发请求", async () => {
  let called = false;
  const model = new MockSpeechModelV4({
    doGenerate: async () => {
      called = true;
      return { audio: MP3, warnings: [], response: RESPONSE };
    },
  });

  await failsWith(
    AudioAgent.synthesize({ model, text: "你好", abortSignal: AbortSignal.abort() }),
    "aborted",
  );
  assert.equal(called, false);
});

test("取消：调用中抛 AbortError → aborted，不是 speech-failed", async () => {
  // fetch 被取消时抛的就是 name 为 AbortError 的异常。
  const aborted = Object.assign(new Error("This operation was aborted"), {
    name: "AbortError",
  });
  const model = new MockSpeechModelV4({
    doGenerate: async () => {
      throw aborted;
    },
  });

  const error = await failsWith(AudioAgent.synthesize({ model, text: "你好" }), "aborted");
  assert.equal(error.cause, aborted);
});

// 造模型：从 baseURL / apiKey / 模型名拼出 OpenAI 兼容的 stt / tts

/** 从 fetch 的第一个参数里取出 URL——它可能是 string、URL 或 Request。 */
function urlOf(input: Parameters<typeof fetch>[0]): string {
  if (typeof input === "string") return input;
  if (input instanceof URL) return input.href;
  return input.url;
}

test("造模型：baseURL / apiKey / 模型名都落到转写请求上", async () => {
  let url = "";
  let auth: string | null = null;
  let form: FormData | undefined;
  const model = AudioAgent.sttModel({
    baseURL: "http://127.0.0.1:8082/v1",
    apiKey: "sk-test",
    model: "whisper-1",
    fetch: async (input, init) => {
      url = urlOf(input);
      auth = new Headers(init?.headers).get("authorization");
      form = init?.body instanceof FormData ? init.body : undefined;
      return new Response(JSON.stringify({ text: "你好世界" }), {
        headers: { "content-type": "application/json" },
      });
    },
  });

  const transcript = await AudioAgent.transcribe({ model, audio: OGG });

  assert.equal(url, "http://127.0.0.1:8082/v1/audio/transcriptions");
  assert.equal(auth, "Bearer sk-test");
  assert.equal(form?.get("model"), "whisper-1");
  assert.equal(transcript.text, "你好世界");
});

test("造模型：baseURL / apiKey / 模型名都落到合成请求上", async () => {
  let url = "";
  let auth: string | null = null;
  let body: Record<string, unknown> = {};
  const model = AudioAgent.ttsModel({
    baseURL: "http://127.0.0.1:6677/v1",
    apiKey: "sk-test",
    model: "tts-1",
    fetch: async (input, init) => {
      url = urlOf(input);
      auth = new Headers(init?.headers).get("authorization");
      body = JSON.parse(String(init?.body));
      return new Response(MP3, { headers: { "content-type": "audio/mpeg" } });
    },
  });

  const speech = await AudioAgent.synthesize({ model, text: "你好", voice: "alloy" });

  assert.equal(url, "http://127.0.0.1:6677/v1/audio/speech");
  assert.equal(auth, "Bearer sk-test");
  assert.equal(body.model, "tts-1");
  assert.equal(body.input, "你好");
  assert.equal(body.voice, "alloy");
  assert.deepEqual(speech.audio.uint8Array, MP3);
});

// base64：要进 JSON / history 的那条路

test("toBase64：不带前缀的 base64；包一层的对象也收", () => {
  const bytes = new Uint8Array([0x66, 0x6f, 0x6f]); // "foo"

  assert.equal(AudioHelper.toBase64(bytes), "Zm9v");
  assert.equal(AudioHelper.toBase64({ uint8Array: bytes }), "Zm9v");
  assert.equal(AudioHelper.toBase64(new Uint8Array()), "");
});
