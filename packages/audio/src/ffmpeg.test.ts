import assert from "node:assert/strict";
import { test } from "node:test";

import {
  argsFor,
  containerExecution,
  directExecution,
  isOggOpus,
  oggOpusDuration,
  spawnAndCollect,
} from "./implementation/ffmpeg.ts";
import { AudioError, AudioHelper } from "./index.ts";

// 命名空间里的函数，测试里拆出来用（没有 this 依赖）。
const { convertToOggOpus, inspectRunner } = AudioHelper;

// 本机能力探测：没有的东西就跳过，别让"没装 ffmpeg"变成"测试挂了"。
const direct = await inspectRunner({ kind: "direct" });
const hasFfmpeg = direct.kind === "direct";
const needsFfmpeg = hasFfmpeg ? false : "本机没有 ffmpeg（inspectRunner 说 direct 不可用）";

// 容器那条路要 build 一个镜像（第一次约一分钟），默认不跑：MIGHT_FFMPEG_TEST_CONTAINER=1 才开。
const container =
  process.env["MIGHT_FFMPEG_TEST_CONTAINER"] === "1"
    ? await inspectRunner({ kind: "build" })
    : ({ kind: "unavailable" } as const);
const needsContainer =
  container.kind === "container" ? false : "没开容器测试（设 MIGHT_FFMPEG_TEST_CONTAINER=1）";

/** 自己造一段 WAV，不往仓库里塞二进制测试文件。 */
function sineWav({ seconds = 0.2, rate = 8000 } = {}): Uint8Array {
  const samples = Math.floor(seconds * rate);
  const data = Buffer.alloc(samples * 2);
  for (let i = 0; i < samples; i++) {
    const value = Math.round(Math.sin((2 * Math.PI * 440 * i) / rate) * 0.5 * 32767);
    data.writeInt16LE(value, i * 2);
  }
  const header = Buffer.alloc(44);
  header.write("RIFF", 0);
  header.writeUInt32LE(36 + data.length, 4);
  header.write("WAVE", 8);
  header.write("fmt ", 12);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20); // PCM
  header.writeUInt16LE(1, 22); // 单声道
  header.writeUInt32LE(rate, 24);
  header.writeUInt32LE(rate * 2, 28);
  header.writeUInt16LE(2, 32);
  header.writeUInt16LE(16, 34);
  header.write("data", 36);
  header.writeUInt32LE(data.length, 40);
  return Buffer.concat([header, data]);
}

/** 跑一次并断言失败码。 */
async function failsWith(run: Promise<unknown>, code: string): Promise<AudioError> {
  try {
    await run;
  } catch (error) {
    assert.ok(error instanceof AudioError, `期望 AudioError，拿到：${String(error)}`);
    assert.equal(error.code, code);
    return error;
  }
  throw new Error(`期望以 ${code} 失败，但它成功了`);
}

test("参数数组只有一份：direct 直接 exec 它，docker 在它前面套一层", () => {
  const args = argsFor();

  // 输入侧的安全大头：关掉所有"跳去别处取数据"的协议。
  assert.deepEqual(args.slice(0, 6), [
    "-hide_banner",
    "-loglevel",
    "error",
    "-protocol_whitelist",
    "pipe",
    "-i",
  ]);
  assert.equal(args.at(-1), "pipe:1");
  assert.ok(args.includes("libopus"));

  assert.deepEqual(directExecution("/usr/bin/ffmpeg", args), {
    command: "/usr/bin/ffmpeg",
    argv: args,
  });

  const docker = containerExecution("docker", "might-ffmpeg:alpine", args);
  assert.equal(docker.command, "docker");
  // 加固参数在镜像名前面，ffmpeg 的参数原样跟在后面——同一份数组，没有第二种写法。
  const imageAt = docker.argv.indexOf("might-ffmpeg:alpine");
  assert.deepEqual(docker.argv.slice(0, 2), ["run", "--rm"]);
  assert.deepEqual(docker.argv.slice(imageAt + 1), args);
  for (const flag of ["--network", "--memory", "--cpus", "--pids-limit", "--read-only"]) {
    assert.ok(docker.argv.includes(flag), `少了 ${flag}`);
  }
  assert.equal(docker.argv[docker.argv.indexOf("--network") + 1], "none");
  // 杀客户端杀不掉容器，所以点名的 cleanup 必须有。
  assert.deepEqual(docker.cleanup?.slice(0, 4), ["docker", "kill", "--signal", "KILL"]);
});

test("isOggOpus：认 Ogg Opus，不认 Ogg 容器里的别的东西", () => {
  const page = (magic: string) =>
    Buffer.concat([Buffer.from("OggS"), Buffer.alloc(20), Buffer.from(magic)]);

  assert.equal(isOggOpus(page("OpusHead")), true);
  // 一样是 Ogg 容器，但装的是 Vorbis —— 只看 OggS 就会把它当成目标格式。
  assert.equal(isOggOpus(page("\u0001vorbis")), false);
  assert.equal(isOggOpus(Buffer.from("ID3\u0003\u0000\u0000")), false);
  assert.equal(isOggOpus(new Uint8Array(0)), false);
  assert.equal(isOggOpus(Buffer.from("OggS")), false);
});

test("oggOpusDuration：读得出生死，也读得出结构不对", () => {
  assert.equal(oggOpusDuration(Buffer.from("这不是 Ogg")), undefined);
  assert.equal(oggOpusDuration(new Uint8Array(0)), undefined);
  // 只有页头没有音频页：没有 OpusHead，就是 undefined。
  assert.equal(oggOpusDuration(Buffer.concat([Buffer.from("OggS"), Buffer.alloc(30)])), undefined);
});

test("空输入本地就挡掉，不启动 ffmpeg", async () => {
  const error = await failsWith(convertToOggOpus(new Uint8Array(0)), "invalid-input");
  assert.ok(error instanceof AudioError);
});

test("超过输入上限本地就挡掉，不启动 ffmpeg", async () => {
  // 输入上限是写死的 25 MB（跟 OpenAI 转写接口对齐），所以这条测试得真拿一个超标的输入来。
  const huge = Buffer.alloc(25 * 1024 * 1024 + 1);
  const error = await failsWith(convertToOggOpus(huge), "too-large");
  assert.equal(error.data.code === "too-large" && error.data.bytes > error.data.limit, true);
});

test("params 可以覆盖默认值：把上限调小，本地就挡掉", async () => {
  // 默认值只是默认：真给了就用给的，而且要在起进程之前就挡住。
  const error = await failsWith(
    convertToOggOpus(sineWav(), undefined, { maxInputBytes: 100 }),
    "too-large",
  );
  assert.equal(error.data.code === "too-large" && error.data.limit === 100, true);
});

test("runner 配错了要出声，不能默默按默认走", async () => {
  await failsWith(
    // biome-ignore lint/suspicious/noExplicitAny: 故意传一个非法值
    convertToOggOpus(sineWav(), { kind: "沙箱" } as any),
    "invalid-input",
  );

  // http runner 没给 url 也是配置错误，而且要在发请求之前就报。
  const saved = process.env["MIGHT_FFMPEG_URL"];
  delete process.env["MIGHT_FFMPEG_URL"];
  try {
    const error = await failsWith(convertToOggOpus(sineWav(), { kind: "http" }), "invalid-input");
    assert.equal(error.field, "runner.url");
  } finally {
    if (saved !== undefined) process.env["MIGHT_FFMPEG_URL"] = saved;
  }
});

test("转一段 WAV → Ogg Opus（direct）", { skip: needsFfmpeg }, async () => {
  const ogg = await convertToOggOpus(sineWav({ seconds: 0.2 }), { kind: "direct" });

  assert.equal(isOggOpus(ogg), true);
  assert.ok(ogg.length > 0);
  // 时长要真的对得上，不是"结构看起来像"。
  const seconds = oggOpusDuration(ogg);
  assert.ok(seconds !== undefined && Math.abs(seconds - 0.2) < 0.03, `时长 ${seconds}`);
});

test("乱码字节 → transcode-failed，stderr 留在 cause 里", { skip: needsFfmpeg }, async () => {
  const garbage = Buffer.from("这不是音频，是一段文字。".repeat(20));
  const error = await failsWith(convertToOggOpus(garbage, { kind: "direct" }), "transcode-failed");
  assert.equal(typeof error.cause, "string");
});

test("空音频轨 → transcode-failed，别把空壳递给下游", { skip: needsFfmpeg }, async () => {
  // 0 采样但头部合法的 WAV：ffmpeg 会**退出码 0** 地吐一个只有头部、没有音频页的 Ogg，
  // isOggOpus 认它（OggS + OpusHead 都在），只有读 granule 才看得出来是 0 秒。
  const error = await failsWith(
    convertToOggOpus(sineWav({ seconds: 0 }), { kind: "direct" }),
    "transcode-failed",
  );
  assert.match(String(error.cause), /0 秒/);
});

test("超时能被抓住，而且进程真的死了", async () => {
  // 超时预算写死在实现里（60 秒），所以这条从执行层测：拿一个必然超时的进程看它被不被杀。
  // 说它是 sleep 不是 ffmpeg 也行——这一层本来就不认识 ffmpeg，只认识"跑起来、超时就杀"。
  const started = Date.now();
  const result = await spawnAndCollect({ command: "sleep", argv: ["30"] }, new Uint8Array(0), {
    timeoutMs: 100,
    maxOutputBytes: 1024,
  });
  assert.equal(result.timedOut, true);
  assert.equal(result.exitCode !== 0, true);
  assert.ok(Date.now() - started < 5_000, "没在超时后立刻结束");
});

test("inspectRunner 说得出自己会走哪条路", async () => {
  const status = await inspectRunner();
  assert.ok(["container", "direct", "unavailable"].includes(status.kind));
  if (status.kind !== "unavailable") assert.equal(typeof status.target, "string");
});

test("自建容器转一次，输出一样是合法的 Ogg Opus", { skip: needsContainer }, async () => {
  const ogg = await convertToOggOpus(sineWav(), { kind: "build" });

  assert.equal(isOggOpus(ogg), true);
  assert.ok(ogg.length > 0);
});
