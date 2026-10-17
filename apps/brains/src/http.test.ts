/**
 * 路由的测试。
 *
 * brain 用假端口——路由只认 BrainPorts，转写/模型/合成都不在这层，所以这里不需要
 * 任何 provider、不需要 ffmpeg、不需要 mock 模型，跑在哪都行。
 *
 * 编码：带音频的两个端点只走 MessagePack；agent 那两个 MessagePack 和 JSON 都收，
 * 响应跟着请求走。所以 agent 那对的用例两种编码各跑一遍。大多用例走 `app.request()`
 * （Web 标准 Request/Response，不起 socket）；另有一条真起 server 走真 socket 的端到端，
 * 确认 Hono 之外的 @hono/node-server 那一段也接得上。
 */
import assert from "node:assert/strict";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { test } from "node:test";

import { createAdaptorServer } from "@hono/node-server";
import { decode, encode } from "@msgpack/msgpack";
import type { Hono } from "hono";

import { type BrainPorts, createBrainRouter } from "./http.ts";

/**
 * 造一段长得像 Ogg Opus 的字节（`OggS` 打头、第一个页里有 `OpusHead`）。
 * 不是要测 Ogg 解析，只是让音频里有"看起来像二进制"的字节，确认它在 MessagePack 的
 * bin 里原样穿过。
 */
function fakeOgg(bytes: readonly number[]): Uint8Array<ArrayBuffer> {
  const head = Buffer.from([0x4f, 0x67, 0x67, 0x53, 0, 2, 1, 0, 0, 0, 0, 0, 0, 0]);
  const opusHead = Buffer.from("OpusHead", "latin1");
  return new Uint8Array([...head, ...opusHead, ...bytes]);
}

/** 一直挂到 signal 中止。假端口用它模拟"暂时没话说"。 */
function untilAborted(signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.resolve();
  return new Promise((resolve) => {
    signal.addEventListener("abort", () => resolve(), { once: true });
  });
}

/** 默认什么都不产出：两个长轮询端点挂到超时（回 empty），两个提交端点空转。 */
function fakePorts(overrides: Partial<BrainPorts> = {}): BrainPorts {
  return {
    humanToBrain() {
      return Promise.resolve({ kind: "text", text: "人类文本" });
    },
    async brainToHuman(_request, { signal }) {
      await untilAborted(signal);
      return { kind: "empty" };
    },
    agentToBrain() {
      return Promise.resolve({ kind: "empty" });
    },
    async brainToAgent(_request, { signal }) {
      await untilAborted(signal);
      return { kind: "empty" };
    },
    ...overrides,
  };
}

function router(overrides: Partial<BrainPorts> = {}, token = "", pollTimeoutMs = 20): Hono {
  return createBrainRouter({ ports: fakePorts(overrides), token, pollTimeoutMs });
}

/** 发一个 MessagePack 请求。 */
async function postMsgpack(
  app: Hono,
  path: string,
  body: unknown,
  headers: Record<string, string> = {},
): Promise<Response> {
  return app.request(path, {
    method: "POST",
    headers: { "content-type": "application/msgpack", ...headers },
    body: encode(body),
  });
}

/** 发一个 JSON 请求。 */
async function postJson(
  app: Hono,
  path: string,
  body: unknown,
  headers: Record<string, string> = {},
): Promise<Response> {
  return app.request(path, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify(body),
  });
}

/** 把 MessagePack 响应体解回对象。 */
async function reply(res: Response): Promise<unknown> {
  return decode(new Uint8Array(await res.arrayBuffer()));
}

/** 按响应的 Content-Type 解回对象，msgpack 和 JSON 都认——用例就不必关心自己发的是哪种。 */
async function read(res: Response): Promise<unknown> {
  return (res.headers.get("content-type") ?? "").startsWith("application/json")
    ? res.json()
    : reply(res);
}

/** agent 那对的两种编码：`[发请求的函数, 该用的 Content-Type]`。同一组用例两种各跑一遍。 */
const encodings = [
  [postMsgpack, "application/msgpack"],
  [postJson, "application/json"],
] as const;

/** 起一个只监听回环的真 server，返回地址和关停函数。 */
async function startServer(app: Hono): Promise<{ url: string; close: () => Promise<void> }> {
  // 我们这个部署只走 http/1，所以拿到的就是 node:http 的 Server。
  const server = createAdaptorServer({ fetch: app.fetch }) as Server;
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;

  return {
    url: `http://127.0.0.1:${port}`,
    // 先掐掉 keep-alive 连接再 close：undici 的 fetch 会留着连接，
    // 光 close() 会一直等它们自然断开，测试就挂在那儿了。
    close: () =>
      new Promise<void>((done) => {
        server.closeAllConnections();
        server.close(() => done());
      }),
  };
}

// 鉴权（规格 §0.2）

test("token 为空时不启用鉴权，连 Authorization 头都不需要", async () => {
  const res = await postMsgpack(router(), "/brain-to-human", { brain_id: "员工3" });
  assert.equal(res.status, 200);
});

test("四个端点一个都不能漏：配了 token 时没头就是 401", async () => {
  const app = router({}, "s3cret");
  const msgpackCalls: ReadonlyArray<readonly [string, unknown]> = [
    ["/human-to-brain", { brain_id: "a", audio: fakeOgg([1]) }],
    ["/brain-to-human", { brain_id: "a" }],
  ];
  const jsonCalls: ReadonlyArray<readonly [string, unknown]> = [
    ["/agent-to-brain", { brain_id: "a", text: "x" }],
    ["/brain-to-agent", { brain_id: "a" }],
  ];

  for (const [path, body] of msgpackCalls) {
    assert.equal((await postMsgpack(app, path, body)).status, 401, `${path} 没要鉴权`);
  }
  for (const [path, body] of jsonCalls) {
    assert.equal((await postJson(app, path, body)).status, 401, `${path} 没要鉴权`);
  }
});

test("配了 token 就要求 Bearer 头；错 token 和缺前缀都是 401", async () => {
  const app = router({}, "s3cret");

  assert.equal((await postMsgpack(app, "/brain-to-human", { brain_id: "a" })).status, 401);
  assert.equal(
    (await postMsgpack(app, "/brain-to-human", { brain_id: "a" }, { authorization: "Bearer nope" }))
      .status,
    401,
  );
  // 长度和正确 token 一样，走的是 timingSafeEqual 那条路，不是长度不等直接判否。
  assert.equal(
    (
      await postMsgpack(
        app,
        "/brain-to-human",
        { brain_id: "a" },
        { authorization: "Bearer s3creT" },
      )
    ).status,
    401,
  );
  // 少 Bearer 前缀。
  assert.equal(
    (await postMsgpack(app, "/brain-to-human", { brain_id: "a" }, { authorization: "s3cret" }))
      .status,
    401,
  );
  assert.equal(
    (
      await postMsgpack(
        app,
        "/brain-to-human",
        { brain_id: "a" },
        { authorization: "Bearer s3cret" },
      )
    ).status,
    200,
  );
});

test("错误响应一律 text/plain，不长得像成功响应", async () => {
  // 客户端按 Content-Type 分派：错误体要是长成 msgpack 或 JSON，就会被当成合法回复去解。
  const app = router({}, "s3cret");
  for (const path of ["/brain-to-human", "/brain-to-agent"]) {
    const res = await postMsgpack(app, path, { brain_id: "a" });
    assert.equal(res.status, 401);
    assert.equal(res.headers.get("content-type")?.split(";")[0], "text/plain");
  }
});

// human-to-brain：解包 msgpack，返回转录

test("human-to-brain 解包 msgpack，把音频和 unheard_text 原样交给 brain，返回转录文本", async () => {
  let seen: { brain_id: string; audio: Uint8Array; unheard_text?: string | null } | undefined;
  const app = router({
    humanToBrain(request) {
      seen = request;
      return Promise.resolve({ kind: "text", text: "今天天气不错" });
    },
  });

  const res = await postMsgpack(app, "/human-to-brain", {
    brain_id: "员工3",
    audio: fakeOgg([1, 2, 3]),
    unheard_text: "刚才那句没听完",
  });

  assert.equal(res.status, 200);
  assert.equal(res.headers.get("content-type")?.split(";")[0], "application/msgpack");
  assert.deepEqual(await reply(res), { kind: "text", text: "今天天气不错" });
  assert.equal(seen?.brain_id, "员工3");
  assert.equal(seen?.unheard_text, "刚才那句没听完");
  assert.ok(seen !== undefined && Buffer.from(seen.audio).includes("OpusHead"));
});

test("human-to-brain 缺 brain_id、缺 audio 或 audio 是空的都是 400", async () => {
  const app = router();

  assert.equal((await postMsgpack(app, "/human-to-brain", { audio: fakeOgg([1]) })).status, 400);
  assert.equal((await postMsgpack(app, "/human-to-brain", { brain_id: "员工3" })).status, 400);
  assert.equal(
    (await postMsgpack(app, "/human-to-brain", { brain_id: "员工3", audio: new Uint8Array() }))
      .status,
    400,
  );

  // 请求体根本不是 msgpack，也走同一条 400。
  const res = await app.request("/human-to-brain", { method: "POST", body: "不是 msgpack" });
  assert.equal(res.status, 400);
});

test("human-to-brain 里 brain 抛了就是 5xx，不是空响应", async () => {
  const app = router({
    humanToBrain() {
      return Promise.reject(new Error("STT 挂了"));
    },
  });
  const res = await postMsgpack(app, "/human-to-brain", { brain_id: "员工3", audio: fakeOgg([1]) });
  assert.equal(res.status, 502);
});

// brain-to-human：长轮询

test('brain-to-human 没话说时挂到超时，返回 { kind: "empty" }', async () => {
  const started = Date.now();
  const res = await postMsgpack(router({}, "", 30), "/brain-to-human", { brain_id: "员工3" });
  const elapsed = Date.now() - started;

  assert.equal(res.status, 200);
  assert.equal(res.headers.get("content-type")?.split(";")[0], "application/msgpack");
  assert.deepEqual(await reply(res), { kind: "empty" });
  // 真的是"挂住"到超时，不是立刻返回。
  assert.ok(elapsed >= 25, `应当阻塞到超时，实际只用了 ${elapsed}ms`);
});

test("brain-to-human 有回复时返回文本 + 音频，音频原样带出", async () => {
  const audio = fakeOgg([0xde, 0xad, 0xbe, 0xef]);
  const app = router({
    brainToHuman() {
      return Promise.resolve({ kind: "text", text: "你好呀", audio });
    },
  });

  const res = await postMsgpack(app, "/brain-to-human", { brain_id: "员工3" });
  assert.equal(res.status, 200);
  assert.equal(res.headers.get("content-type")?.split(";")[0], "application/msgpack");

  const body = (await reply(res)) as { kind: string; text: string; audio: Uint8Array };
  assert.equal(body.kind, "text");
  assert.equal(body.text, "你好呀");
  assert.ok(Buffer.from(body.audio).equals(Buffer.from(audio)), "音频字节要原样还原");
});

test("brain-to-human 缺 brain_id 是 400，请求体不是 msgpack 也是 400", async () => {
  const app = router();
  assert.equal((await postMsgpack(app, "/brain-to-human", {})).status, 400);
  assert.equal((await postMsgpack(app, "/brain-to-human", { brain_id: "" })).status, 400);
  assert.equal(
    (await app.request("/brain-to-human", { method: "POST", body: "不是 msgpack" })).status,
    400,
  );
});

test("brain_id 超过 64 字符是 400（客户端可控的键，别让它无限长）", async () => {
  const res = await postJson(router(), "/brain-to-agent", { brain_id: "x".repeat(65) });
  assert.equal(res.status, 400);
});

test("音色是 per-request：两个提交端点都往下传（新名/旧名都认，并 trim）", async () => {
  const seen: { human?: string; agent?: string } = {};
  const app = router({
    humanToBrain(request) {
      seen.human = request.voice;
      return Promise.resolve({ kind: "text", text: "x" });
    },
    agentToBrain(request) {
      seen.agent = request.voice;
      return Promise.resolve({ kind: "empty" });
    },
  });

  await postMsgpack(
    app,
    "/human-to-brain",
    { brain_id: "员工3", audio: fakeOgg([1]) },
    { "x-brain-voice": "voice-a" },
  );
  await postJson(
    app,
    "/agent-to-brain",
    { brain_id: "员工3", text: "x" },
    { "x-might-voice": "  voice-b  " },
  );

  assert.equal(seen.human, "voice-a");
  assert.equal(seen.agent, "voice-b");
});

test("brain 抛了但其实是超时，也算 empty 而不是 5xx", async () => {
  const app = router({
    async brainToHuman(_request, { signal }) {
      await untilAborted(signal);
      // 端口实现没守"中止就返回 empty"的约定，路由要兜住。
      throw new Error("端口实现没守约定");
    },
  });

  const res = await postMsgpack(app, "/brain-to-human", { brain_id: "员工3" });
  assert.equal(res.status, 200);
  assert.deepEqual(await reply(res), { kind: "empty" });
});

test("带音频的两个端点只走 MessagePack：JSON 请求也是 400", async () => {
  const app = router();
  // 上行 request 带音频 bin，下行 response 带音频 bin——都装不进 JSON。
  assert.equal(
    (await postJson(app, "/human-to-brain", { brain_id: "员工3", audio: "不是二进制" })).status,
    400,
  );
  assert.equal((await postJson(app, "/brain-to-human", { brain_id: "员工3" })).status, 400);
});

// agent-to-brain：写入，不等。两种编码各跑一遍

test("agent-to-brain 两种编码都收，把文本交给 brain，响应跟着请求走", async () => {
  let seen: { brain_id: string; text: string } | undefined;
  const app = router({
    agentToBrain(request) {
      seen = request;
      return Promise.resolve({ kind: "empty" });
    },
  });

  for (const [post, type] of encodings) {
    const res = await post(app, "/agent-to-brain", { brain_id: "员工3", text: "开灯" });

    assert.equal(res.status, 200);
    // 关键：响应编码必须和请求一致——JSON 进 JSON 出，msgpack 进 msgpack 出。
    assert.equal(res.headers.get("content-type")?.split(";")[0], type);
    assert.deepEqual(await read(res), { kind: "empty" });
    assert.deepEqual(seen, { brain_id: "员工3", text: "开灯" });
  }
});

test("agent-to-brain 缺 text 或 text 是空的都是 400，请求体不是 JSON/msgpack 也是 400", async () => {
  const app = router();
  for (const [post] of encodings) {
    assert.equal((await post(app, "/agent-to-brain", { brain_id: "员工3" })).status, 400);
    assert.equal((await post(app, "/agent-to-brain", { brain_id: "员工3", text: "" })).status, 400);
    assert.equal((await post(app, "/agent-to-brain", { text: "开灯" })).status, 400);
  }

  // 声称是 JSON 却给了别的，也走同一条 400。
  const res = await app.request("/agent-to-brain", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: "不是 JSON",
  });
  assert.equal(res.status, 400);
});

test("agent-to-brain 不做长轮询：brain 立刻返回就立刻响应", async () => {
  // 写入端点的语义是"收下即返回"，不该像出 brain 那两个端点那样挂到超时。
  for (const [post] of encodings) {
    const started = Date.now();
    const res = await post(router({}, "", 5000), "/agent-to-brain", {
      brain_id: "员工3",
      text: "开灯",
    });
    assert.equal(res.status, 200);
    assert.ok(Date.now() - started < 1000, "写入端点不该等");
  }
});

test("agent-to-brain 里 brain 抛了是 500", async () => {
  const app = router({
    agentToBrain() {
      return Promise.reject(new Error("写 history 挂了"));
    },
  });
  for (const [post] of encodings) {
    const res = await post(app, "/agent-to-brain", { brain_id: "员工3", text: "开灯" });
    assert.equal(res.status, 500);
  }
});

// brain-to-agent：长轮询，返回文本。两种编码各跑一遍

test('brain-to-agent 没内容时挂到超时，返回 { kind: "empty" }', async () => {
  for (const [post, type] of encodings) {
    const started = Date.now();
    const res = await post(router({}, "", 30), "/brain-to-agent", { brain_id: "员工3" });
    const elapsed = Date.now() - started;

    assert.equal(res.status, 200);
    assert.equal(res.headers.get("content-type")?.split(";")[0], type);
    assert.deepEqual(await read(res), { kind: "empty" });
    assert.ok(elapsed >= 25, `应当阻塞到超时，实际只用了 ${elapsed}ms`);
  }
});

test("brain-to-agent 拿到文本时返回 kind=text，内容原样带出（中文、换行都在）", async () => {
  const app = router({
    brainToAgent() {
      return Promise.resolve({ kind: "text", text: "他说：\n今天天气不错" });
    },
  });

  for (const [post, type] of encodings) {
    const res = await post(app, "/brain-to-agent", { brain_id: "员工3" });
    assert.equal(res.status, 200);
    assert.equal(res.headers.get("content-type")?.split(";")[0], type);
    assert.deepEqual(await read(res), { kind: "text", text: "他说：\n今天天气不错" });
  }
});

test("brain-to-agent 缺 brain_id 是 400", async () => {
  for (const [post] of encodings) {
    assert.equal((await post(router(), "/brain-to-agent", {})).status, 400);
  }
});

test("brain-to-agent 也把中止归一成 empty", async () => {
  const app = router({
    async brainToAgent(_request, { signal }) {
      await untilAborted(signal);
      throw new Error("端口实现没守约定");
    },
  });
  for (const [post] of encodings) {
    const res = await post(app, "/brain-to-agent", { brain_id: "员工3" });
    assert.equal(res.status, 200);
    assert.deepEqual(await read(res), { kind: "empty" });
  }
});

// 端到端：真起一个 server 走真 socket

test("真 server：四个端点都接得上", async () => {
  const audio = fakeOgg([7, 7, 7]);
  const app = router({
    humanToBrain() {
      return Promise.resolve({ kind: "text", text: "人类文本" });
    },
    brainToHuman() {
      return Promise.resolve({ kind: "text", text: "ai文本", audio });
    },
    agentToBrain() {
      return Promise.resolve({ kind: "empty" });
    },
    brainToAgent() {
      return Promise.resolve({ kind: "text", text: "给 agent 的文本" });
    },
  });

  const server = await startServer(app);
  const sendMsgpack = (path: string, body: unknown): Promise<Response> =>
    fetch(`${server.url}${path}`, {
      method: "POST",
      headers: { "content-type": "application/msgpack" },
      body: encode(body),
    });
  const sendJson = (path: string, body: unknown): Promise<Response> =>
    fetch(`${server.url}${path}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });

  try {
    const spoken = await sendMsgpack("/human-to-brain", { brain_id: "员工3", audio });
    assert.equal(spoken.status, 200);
    assert.deepEqual(await reply(spoken), { kind: "text", text: "人类文本" });

    const responded = await sendMsgpack("/brain-to-human", { brain_id: "员工3" });
    assert.equal(responded.status, 200);
    const body = (await reply(responded)) as { kind: string; text: string; audio: Uint8Array };
    assert.equal(body.kind, "text");
    assert.equal(body.text, "ai文本");
    assert.ok(Buffer.from(body.audio).equals(Buffer.from(audio)), "音频字节要原样还原");

    // agent 那对各挑一种编码走真 socket，两种都验到。
    const acted = await sendJson("/agent-to-brain", { brain_id: "员工3", text: "开灯" });
    assert.equal(acted.status, 200);
    assert.deepEqual(await acted.json(), { kind: "empty" });

    const steered = await sendMsgpack("/brain-to-agent", { brain_id: "员工3" });
    assert.equal(steered.status, 200);
    assert.deepEqual(await read(steered), { kind: "text", text: "给 agent 的文本" });
  } finally {
    await server.close();
  }
});
