/**
 * WASM 那条路：**不碰 ffmpeg、不碰容器**，所以在任何机器上都必须跑得起来。
 *
 * 测试用的 WebM 也是 WASM 编出来的（@audio/encode-webm 是 devDependency，只在测试里用），
 * 这样这条测试不依赖本机装没装 ffmpeg。真·现实世界的验证是另一回事：拿 Chrome 真录的
 * WebM 跑过一遍，产物喂给线上 ASR 能正确转写。
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import encodeWebm from "@audio/encode-webm";

import { isOggOpus, oggOpusDuration } from "./implementation/transcode.ts";
import { runWasm } from "./implementation/wasm-runner.ts";
import { AudioError, AudioHelper } from "./index.ts";

const { convertToOggOpus, inspectRunner } = AudioHelper;

// 容器那条路要 docker，没有就跳过（跟 ffmpeg.test.ts 一个规矩）。
const container = await inspectRunner({ kind: "build" });
const needsContainer =
  container.kind === "container"
    ? false
    : "本机没有可用的容器运行时（inspectRunner 说 build 不可用）";

/** 用 WASM 编一段 WebM/Opus：440 Hz 正弦，跟 ffmpeg 那条测试造 WAV 是一个路子。 */
async function sineWebm(seconds = 1): Promise<Uint8Array> {
  const sampleRate = 48_000;
  const samples = Math.floor(seconds * sampleRate);
  const channel = new Float32Array(samples);
  for (let i = 0; i < samples; i++)
    channel[i] = Math.sin((2 * Math.PI * 440 * i) / sampleRate) * 0.5;

  const encoder = await encodeWebm({ sampleRate, channels: 1, bitrate: 64 });
  return Buffer.concat([Buffer.from(encoder.encode([channel])), Buffer.from(encoder.flush())]);
}

test("WebM/Opus → Ogg Opus，全程 WASM", async () => {
  const webm = await sineWebm(1);
  assert.equal(Buffer.from(webm.subarray(0, 4)).toString("hex"), "1a45dfa3"); // EBML 魔数

  const ogg = await convertToOggOpus(webm, { kind: "wasm" });

  assert.equal(isOggOpus(ogg), true);
  const seconds = oggOpusDuration(ogg);
  assert.ok(seconds !== undefined && Math.abs(seconds - 1) < 0.05, `时长 ${seconds}`);
});

test("已经是 Ogg Opus 的也能再走一遍（解码 → 重编码）", async () => {
  const ogg = await convertToOggOpus(await sineWebm(0.5), { kind: "wasm" });
  const again = await convertToOggOpus(ogg, { kind: "wasm" });

  assert.equal(isOggOpus(again), true);
  const seconds = oggOpusDuration(again);
  assert.ok(seconds !== undefined && Math.abs(seconds - 0.5) < 0.05, `时长 ${seconds}`);
});

test("认不出的格式明确失败，并且告诉你去换哪条路", async () => {
  // MP3 的头（ID3）——wasm 这条不认，因为它没有 MP3 解码器（更要紧的是 AAC 那个是 GPL）。
  const mp3ish = Buffer.concat([Buffer.from("ID3\u0003\u0000\u0000"), Buffer.alloc(64)]);

  try {
    await convertToOggOpus(mp3ish, { kind: "wasm" });
    assert.fail("本该失败");
  } catch (error) {
    assert.ok(error instanceof AudioError);
    assert.equal(error.code, "transcode-failed");
    assert.match(String(error.cause), /build \/ direct/);
  }
});

test("maxDurationSeconds 在 wasm 这条路上也截断", async () => {
  const ogg = await runWasm({ ...defaultParams(), maxDurationSeconds: 0.4 }, await sineWebm(2));

  const seconds = oggOpusDuration(ogg.bytes);
  assert.ok(seconds !== undefined && seconds < 0.5, `时长 ${seconds}（2 秒输入，上限 0.4 秒）`);
});

test("默认路（不给 kind）认得出 WebM", async () => {
  // 不给 runner 时默认就是 wasm，不用装 ffmpeg 也应该能转。
  const saved = process.env["MIGHT_FFMPEG_RUNNER"];
  delete process.env["MIGHT_FFMPEG_RUNNER"];
  try {
    const ogg = await convertToOggOpus(await sineWebm(0.5));
    assert.equal(isOggOpus(ogg), true);
  } finally {
    if (saved !== undefined) process.env["MIGHT_FFMPEG_RUNNER"] = saved;
  }
});

test("默认路认不出的格式：容器也没有的时候，两条路的话都说出来", async () => {
  // 把 PATH 清空，docker 就"不存在"了——这正是没有容器的那台机器上会发生的事。
  const savedPath = process.env["PATH"];
  const savedRunner = process.env["MIGHT_FFMPEG_RUNNER"];
  delete process.env["MIGHT_FFMPEG_RUNNER"];
  process.env["PATH"] = "";
  try {
    await convertToOggOpus(Buffer.concat([Buffer.from("ID3\u0003\u0000\u0000"), Buffer.alloc(64)]));
    assert.fail("本该失败");
  } catch (error) {
    assert.ok(error instanceof AudioError);
    // wasm 说它认不出，容器说它起不来——两个都留着，不然调用点不知道该换什么。
    assert.match(String(error.cause), /wasm 这条路认不出/);
    assert.match(String(error.cause), /容器那条路也起不来/);
  } finally {
    process.env["PATH"] = savedPath;
    if (savedRunner !== undefined) process.env["MIGHT_FFMPEG_RUNNER"] = savedRunner;
  }
});

test("默认路：wasm 不认的格式自动换容器（WAV 就是）", { skip: needsContainer }, async () => {
  // WAV 没有装 MIT 解码器，wasm 认不出——默认路会自己换到容器，调用点什么都不用管。
  const saved = process.env["MIGHT_FFMPEG_RUNNER"];
  delete process.env["MIGHT_FFMPEG_RUNNER"];
  try {
    const ogg = await convertToOggOpus(sineWav(0.3));
    assert.equal(isOggOpus(ogg), true);
    const seconds = oggOpusDuration(ogg);
    assert.ok(seconds !== undefined && Math.abs(seconds - 0.3) < 0.05, `时长 ${seconds}`);
  } finally {
    if (saved !== undefined) process.env["MIGHT_FFMPEG_RUNNER"] = saved;
  }
});

/** 造一段 WAV：wasm 那条没有 WAV 解码器，专门用来测"换容器"这条分支。 */
function sineWav(seconds: number, rate = 8000): Uint8Array {
  const samples = Math.floor(seconds * rate);
  const data = Buffer.alloc(samples * 2);
  for (let i = 0; i < samples; i++) {
    data.writeInt16LE(Math.round(Math.sin((2 * Math.PI * 440 * i) / rate) * 0.5 * 32767), i * 2);
  }
  const header = Buffer.alloc(44);
  header.write("RIFF", 0);
  header.writeUInt32LE(36 + data.length, 4);
  header.write("WAVE", 8);
  header.write("fmt ", 12);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(1, 22);
  header.writeUInt32LE(rate, 24);
  header.writeUInt32LE(rate * 2, 28);
  header.writeUInt16LE(2, 32);
  header.writeUInt16LE(16, 34);
  header.write("data", 36);
  header.writeUInt32LE(data.length, 40);
  return Buffer.concat([header, data]);
}

test("inspectRunner 报得出 wasm", async () => {
  const status = await AudioHelper.inspectRunner({ kind: "wasm" });
  assert.equal(status.kind, "wasm");
});

/** runWasm 直接调用时要一整份参数，这里跟实现里的默认值对齐。 */
function defaultParams() {
  return {
    bitrateKbps: 32,
    sampleRate: 48_000,
    channels: 1,
    maxDurationSeconds: 600,
    timeoutMs: 60_000,
    maxInputBytes: 25 * 1024 * 1024,
    maxOutputBytes: 32 * 1024 * 1024,
  };
}
