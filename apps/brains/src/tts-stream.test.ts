import assert from "node:assert/strict";
import { test } from "node:test";

import { encode } from "@msgpack/msgpack";

import { parseTtsFrames } from "./tts-stream.ts";

/** 按 TTS 的线上格式打包：`[u32 小端长度][msgpack]`。 */
function framed(objects: readonly unknown[]): Uint8Array<ArrayBuffer> {
  const out = new Uint8Array(0);
  const parts: Uint8Array[] = [out];
  let total = 0;

  for (const object of objects) {
    const body = encode(object);
    const head = new Uint8Array(4);
    new DataView(head.buffer).setUint32(0, body.byteLength, true);
    parts.push(head, body);
    total += 4 + body.byteLength;
  }

  const merged = new Uint8Array(total);
  let at = 0;
  for (const part of parts) {
    merged.set(part, at);
    at += part.length;
  }
  return merged;
}

/** 把一段字节按任意大小切成"网络分片"，模拟 chunked 传输。 */
async function* pieces(bytes: Uint8Array, size: number): AsyncGenerator<Uint8Array> {
  for (let at = 0; at < bytes.length; at += size) yield bytes.subarray(at, at + size);
}

test("parseTtsFrames：header 忽略，chunk 原样出，end 收尾", async () => {
  const audioA = new Uint8Array([1, 2, 3]);
  const audioB = new Uint8Array([4, 5]);
  const bytes = framed([
    { kind: "header" },
    { kind: "chunk", audio: audioA, format: "wav" },
    { kind: "chunk", audio: audioB, format: "wav" },
    { kind: "end" },
  ]);

  const frames = [];
  for await (const frame of parseTtsFrames(pieces(bytes, 3))) frames.push(frame);

  assert.equal(frames.length, 2);
  assert.deepEqual(frames[0]?.kind, "chunk");
  assert.deepEqual((frames[0] as { audio: Uint8Array }).audio, audioA);
  assert.equal((frames[0] as { format: string }).format, "wav");
  assert.deepEqual((frames[1] as { audio: Uint8Array }).audio, audioB);
});

test("parseTtsFrames：长度是小端", async () => {
  // 头 4 字节按小端写；如果实现按大端读，会直接卡住/抛。
  const bytes = framed([
    { kind: "chunk", audio: new Uint8Array([9]), format: "opus" },
    { kind: "end" },
  ]);
  assert.deepEqual([...bytes.subarray(0, 4)], [bytes[0], bytes[1], 0, 0]);

  const frames = [];
  for await (const frame of parseTtsFrames(pieces(bytes, 1))) frames.push(frame);
  assert.equal(frames.length, 1);
});

test("parseTtsFrames：error 帧透出来", async () => {
  const bytes = framed([{ kind: "error", error: "daemon 挂了" }]);
  const frames = [];
  for await (const frame of parseTtsFrames(pieces(bytes, 7))) frames.push(frame);
  assert.deepEqual(frames, [{ kind: "error", error: "daemon 挂了" }]);
});

test("parseTtsFrames：没有 end 就 EOF = 截断，抛", async () => {
  const bytes = framed([{ kind: "chunk", audio: new Uint8Array([1]), format: "wav" }]);
  await assert.rejects(async () => {
    for await (const _frame of parseTtsFrames(pieces(bytes, 5))) {
      // 读到 chunk 后继续，直到抛
    }
  }, /没有 end 帧/);
});
