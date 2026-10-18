/**
 * 流式 TTS 客户端。
 *
 * 端点：`POST {TTS_API_BASE_URL}/audio/speech/stream`（JSON 进，MessagePack 帧流出）。
 * 帧格式是 `[u32 **小端** 长度][msgpack]`——注意这里和 Brain API 自己的帧是相反字节序。
 *
 * 对象只有四种：
 *
 *   { kind: "header" }                                  // 忽略
 *   { kind: "chunk", audio: bin, format: "wav" | ... }  // 自包含音频（单独就能播）
 *   { kind: "end" }                                     // 正常结束
 *   { kind: "error", error: string }                    // 流中途失败
 */
import { decode } from "@msgpack/msgpack";

export type TtsFrame =
  | { kind: "chunk"; audio: Uint8Array; format: string }
  | { kind: "error"; error: string };

function concat(left: Uint8Array, right: Uint8Array): Uint8Array<ArrayBuffer> {
  const merged = new Uint8Array(left.length + right.length);
  merged.set(left);
  merged.set(right, left.length);
  return merged;
}

/**
 * 把字节流拆成帧。抽出来是为了能单测——真正的网络那一半在 `streamVoice` 里。
 *
 * 没有 `end` 帧就读到 EOF = 流被截断，抛。
 */
export async function* parseTtsFrames(stream: AsyncIterable<Uint8Array>): AsyncGenerator<TtsFrame> {
  let buf: Uint8Array<ArrayBuffer> = new Uint8Array(0);

  for await (const piece of stream) {
    buf = concat(buf, piece);

    while (buf.length >= 4) {
      const length = new DataView(buf.buffer, buf.byteOffset, buf.byteLength).getUint32(0, true);
      if (buf.length < 4 + length) break;

      const object = decode(buf.subarray(4, 4 + length)) as Record<string, unknown>;
      buf = buf.subarray(4 + length);

      if (object.kind === "chunk") {
        yield {
          kind: "chunk",
          audio: object.audio as Uint8Array,
          format: String(object.format ?? ""),
        };
      } else if (object.kind === "error") {
        // error 是终止帧：后面的东西没有意义了。
        yield { kind: "error", error: String(object.error ?? "unknown") };
        return;
      } else if (object.kind === "end") {
        return;
      }
      // "header" 及其它未知 kind：忽略。
    }
  }

  throw new Error("TTS 流没有 end 帧就结束了");
}

/**
 * 合成一段文本，**边合成边返回**音频块。
 *
 * 每块音频是自包含的（`format: "opus"` 时是独立的 Ogg Opus 文件），所以可以一块一块地当帧发。
 */
export async function* streamVoice(
  text: string,
  voice: string,
  options: { signal?: AbortSignal } = {},
): AsyncGenerator<{ audio: Uint8Array; format: string }> {
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
      input: text,
      voice,
      audio_format: "opus",
      chunk_seconds: 2.0,
      framing: "len",
    }),
    signal: options.signal,
  });

  if (!res.ok || res.body === null) {
    const detail = res.ok ? "没有 body" : (await res.text()).slice(0, 200);
    throw new Error(`TTS 流返回 ${res.status}：${detail}`);
  }

  const reader = res.body.getReader();
  async function* bytes(): AsyncGenerator<Uint8Array> {
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) return;
        yield value;
      }
    } finally {
      await reader.cancel().catch(() => {});
    }
  }

  for await (const frame of parseTtsFrames(bytes())) {
    if (frame.kind === "error") throw new Error(`TTS 流出错：${frame.error}`);
    yield { audio: frame.audio, format: frame.format };
  }
}
