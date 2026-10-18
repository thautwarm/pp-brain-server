/**
 * 流式 TTS 客户端。
 *
 * 端点：`POST {TTS_API_BASE_URL}/audio/speech/stream`，JSON 进、**裸 Ogg Opus 流出**。
 * 这里只做两件事：把请求发出去、核一下格式，然后把 `response.body` 原样交给调用方。
 */

/**
 * 打开一次合成。返回的字节流可以边到边转发。
 *
 * 失败（HTTP 非 2xx、没有 body、格式不对）会在**返回之前**抛——这样调用方还来得及回 502。
 */
export async function openSpeech(
  text: string,
  voice: string,
  options: { signal?: AbortSignal } = {},
): Promise<AsyncIterable<Uint8Array>> {
  const base = process.env.TTS_API_BASE_URL;
  if (base === undefined || base === "") throw new Error("TTS_API_BASE_URL 没配");

  const key = process.env.TTS_API_KEY ?? "";
  const res = await fetch(`${base.replace(/\/+$/, "")}/audio/speech/stream`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(key === "" ? {} : { authorization: `Bearer ${key}` }),
    },
    body: JSON.stringify({
      prompt: text,
      voice,
      seed: -1,
      audio_format: "opus",
    }),
    signal: options.signal,
  });

  if (!res.ok || res.body === null) {
    const detail = res.ok ? "没有 body" : (await res.text()).slice(0, 200);
    throw new Error(`TTS 返回 ${res.status}：${detail}`);
  }

  // 出声之前就把格式核掉：Brain API 只承诺 Ogg Opus。
  const type = res.headers.get("content-type") ?? "";
  if (!type.includes("ogg") && !type.includes("opus")) {
    await res.body.cancel().catch(() => {});
    throw new Error(`TTS 返回的不是 Ogg（${type || "没有 content-type"}）`);
  }

  const reader = res.body.getReader();
  return {
    async *[Symbol.asyncIterator]() {
      try {
        for (;;) {
          const { done, value } = await reader.read();
          if (done) return;
          yield value;
        }
      } finally {
        await reader.cancel().catch(() => {});
      }
    },
  };
}
