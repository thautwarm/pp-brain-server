/**
 * HTTP runner 的测试。这一路不碰本机 ffmpeg，所以哪都能跑——测试里现起一个真的 HTTP 服务，
 * 全程走真链路（真的 fetch、真的超时、真的字节），不 mock。
 */
import assert from "node:assert/strict";
import type { IncomingMessage, ServerResponse } from "node:http";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { test } from "node:test";

import { postForOgg } from "./implementation/ffmpeg.ts";
import { AudioError, AudioHelper } from "./index.ts";

// 命名空间里的函数，测试里拆出来用（没有 this 依赖）。
const { convertToOggOpus, inspectRunner } = AudioHelper;

type Handler = (req: IncomingMessage, res: ServerResponse, body: Buffer) => void;

/** 起一个只监听回环的服务，返回地址和关停函数。 */
async function serve(handler: Handler): Promise<{ url: string; close: () => Promise<void> }> {
  const server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => handler(req, res, Buffer.concat(chunks)));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}/convert`,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

/**
 * 造一段结构合法的 Ogg Opus，不经过 ffmpeg：一个 OpusHead 页 + 一个音频页。
 * 这不是在测"Ogg 解析对不对"（那个拿 ffmpeg 真产出来测），是给 HTTP 那一路当已知答案用。
 */
function fakeOggOpus(seconds: number): Buffer {
  const head = Buffer.alloc(19);
  head.write("OpusHead", 0, "latin1");
  head.writeUInt8(1, 8); // 版本
  head.writeUInt8(1, 9); // 声道
  head.writeUInt16LE(312, 10); // pre-skip
  head.writeUInt32LE(48_000, 12);
  return Buffer.concat([
    oggPage(Buffer.concat([head, Buffer.alloc(8)]), 0n),
    // granule 是"总采样数"，减掉 pre-skip 才是时长。
    oggPage(Buffer.from([0xfc, 0xff, 0xfe]), BigInt(Math.round(seconds * 48_000) + 312)),
  ]);
}

function oggPage(body: Buffer, granule: bigint): Buffer {
  const header = Buffer.alloc(28);
  header.write("OggS", 0, "latin1");
  header.writeUInt8(2, 5); // header type
  header.writeBigUInt64LE(granule, 6);
  header.writeUInt8(1, 26); // 段数
  header.writeUInt8(body.length, 27); // 段大小（这里都 < 255）
  return Buffer.concat([header, body]);
}

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

const AUDIO = Buffer.from("假装这是一段 webm/opus");
/** 直接打 postForOgg 时用的参数：转码参数是写死的那几个值，只把护栏调小好测极值。 */
const HTTP_PARAMS = {
  bitrateKbps: 32,
  sampleRate: 48_000,
  channels: 1,
  maxDurationSeconds: 600,
};
const HTTP_LIMITS = { timeoutMs: 5_000, maxOutputBytes: 8_192 };

/** 把 multipart body 拆成 name → 内容，够看清楚发出去的是什么就行。 */
function parseMultipart(body: Buffer, contentType: string | undefined): Record<string, Buffer> {
  const boundary = /boundary=(.+)$/.exec(contentType ?? "")?.[1];
  assert.ok(boundary !== undefined, `不是 multipart：${contentType}`);
  const parts: Record<string, Buffer> = {};
  for (const raw of body.toString("latin1").split(`--${boundary}`)) {
    const split = raw.indexOf("\r\n\r\n");
    if (split < 0) continue;
    const name = /name="([^"]+)"/.exec(raw.slice(0, split))?.[1];
    if (name === undefined) continue;
    // 每段末尾会多一个 \r\n（分隔符的前半截），去掉它。
    parts[name] = Buffer.from(raw.slice(split + 4).replace(/\r\n$/, ""), "latin1");
  }
  return parts;
}

test("multipart 上行、音频下行：字段是写死的那套，文件段就是原始输入", async () => {
  let seen: { url: string; type: string | undefined; body: Buffer } | undefined;
  const server = await serve((req, res, body) => {
    seen = { url: req.url ?? "", type: req.headers["content-type"], body };
    // 分两块发，看客户端是不是真按流收的。
    res.writeHead(200, { "content-type": "audio/ogg" });
    const ogg = fakeOggOpus(2);
    res.write(ogg.subarray(0, 10));
    res.end(ogg.subarray(10));
  });
  try {
    const ogg = await convertToOggOpus(AUDIO, { kind: "http", url: server.url });

    assert.deepEqual(ogg, fakeOggOpus(2));
    assert.match(seen?.type ?? "", /^multipart\/form-data; boundary=/);
    assert.equal(seen?.url, new URL(server.url).pathname);

    const parts = parseMultipart(seen?.body ?? Buffer.alloc(0), seen?.type);
    assert.equal(parts["bitrateKbps"]?.toString(), "32");
    assert.equal(parts["sampleRate"]?.toString(), "48000");
    assert.equal(parts["channels"]?.toString(), "1");
    assert.equal(parts["maxDurationSeconds"]?.toString(), "600");
    assert.equal(parts["audio"]?.toString(), AUDIO.toString());
  } finally {
    await server.close();
  }
});

test("params 改了会跟着上行", async () => {
  let seen: { type: string | undefined; body: Buffer } | undefined;
  const server = await serve((req, res, body) => {
    seen = { type: req.headers["content-type"], body };
    res.writeHead(200).end(fakeOggOpus(1));
  });
  try {
    await convertToOggOpus(
      AUDIO,
      { kind: "http", url: server.url },
      { bitrateKbps: 12, channels: 2 },
    );

    const parts = parseMultipart(seen?.body ?? Buffer.alloc(0), seen?.type);
    assert.equal(parts["bitrateKbps"]?.toString(), "12");
    assert.equal(parts["channels"]?.toString(), "2");
    assert.equal(parts["sampleRate"]?.toString(), "48000"); // 没改的还是默认值
  } finally {
    await server.close();
  }
});

test("服务返回错误码 → transcode-failed，错误内容留在 cause 里", async () => {
  const server = await serve((_req, res) => {
    res.writeHead(500, { "content-type": "text/plain" }).end("boom: decoder exploded\n");
  });
  try {
    const error = await failsWith(
      convertToOggOpus(AUDIO, { kind: "http", url: server.url }),
      "transcode-failed",
    );
    assert.match(String(error.cause), /500.*boom: decoder exploded/);
  } finally {
    await server.close();
  }
});

test("对面返回的不是 Ogg Opus → transcode-failed，别把垃圾递给下游", async () => {
  const server = await serve((_req, res) => {
    res.writeHead(200, { "content-type": "audio/ogg" }).end("我其实是 HTML");
  });
  try {
    await failsWith(convertToOggOpus(AUDIO, { kind: "http", url: server.url }), "transcode-failed");
  } finally {
    await server.close();
  }
});

test("对面返回 0 秒的空壳 → transcode-failed", async () => {
  const server = await serve((_req, res) => res.writeHead(200).end(fakeOggOpus(0)));
  try {
    const error = await failsWith(
      convertToOggOpus(AUDIO, { kind: "http", url: server.url }),
      "transcode-failed",
    );
    assert.match(String(error.cause), /0 秒/);
  } finally {
    await server.close();
  }
});

test("服务不回话 → timed-out", async () => {
  // 超时预算写死在实现里（60 秒），所以这条直接打机制层。
  // 收下请求就晾着，什么都不回。
  const server = await serve(() => {});
  try {
    const result = await postForOgg(server.url, HTTP_PARAMS, AUDIO, {
      ...HTTP_LIMITS,
      timeoutMs: 100,
    });
    assert.equal(result.timedOut, true);
  } finally {
    await server.close();
  }
});

test("服务连不上 → ffmpeg-missing（部署问题，不是这个文件的错）", async () => {
  const server = await serve(() => {});
  const { url } = server;
  await server.close(); // 端口已经放掉了，接下来连必然被拒
  await failsWith(convertToOggOpus(AUDIO, { kind: "http", url }), "ffmpeg-missing");
});

test("响应超过输出上限就掐断，不读到底", async () => {
  let written = 0;
  const server = await serve((_req, res) => {
    res.writeHead(200, { "content-type": "audio/ogg" });
    const timer = setInterval(() => {
      written += 4096;
      res.write(Buffer.alloc(4096));
    }, 1);
    res.on("close", () => clearInterval(timer));
  });
  try {
    // 上限是写死的 32 MB，这里直接打机制层，不然得真传 32 MB 才碰得到。
    const result = await postForOgg(server.url, HTTP_PARAMS, AUDIO, HTTP_LIMITS);
    assert.equal(result.overflowed, true);
    assert.ok(result.bytes.length <= HTTP_LIMITS.maxOutputBytes);
    // 没读完：对面被掐断之后不该再无限发下去。给一点时间让它多写几轮。
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.ok(written < 1024 * 1024, `对面写了 ${written} 字节，说明我们没断开`);
  } finally {
    await server.close();
  }
});

test("inspectRunner 对 http 报配置，不发请求", async () => {
  // 端口上什么都没有：真去连了就会是 unavailable，这里应该是 http。
  const status = await inspectRunner({ kind: "http", url: "http://127.0.0.1:1/convert" });
  assert.equal(status.kind, "http");
  assert.equal(status.target, "http://127.0.0.1:1/convert");
});

test("runner 是可以捧着走的配置：同一个对象反复用", async () => {
  const server = await serve((_req, res) => res.writeHead(200).end(fakeOggOpus(1)));
  try {
    const runner = { kind: "http", url: server.url } as const;
    const first = await convertToOggOpus(AUDIO, runner);
    const second = await convertToOggOpus(AUDIO, runner);
    assert.equal(first.length > 0 && second.length > 0, true);
  } finally {
    await server.close();
  }
});
