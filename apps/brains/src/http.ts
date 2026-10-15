/**
 * Brain API 的 HTTP 层：四个端点、鉴权、请求校验、两个长轮询。
 *
 * 这一层只认协议，不认 brain：队列、转写、模型、合成都归 brain 层。两边靠 BrainPorts
 * 这唯一的缝隔开——所以这个文件不 import @might/chat / @might/audio 的任何东西，
 * 反过来 brain 层也不必知道 HTTP 长什么样。
 *
 * 四个端点刚好是一张 2×2：谁（human / agent）× 方向（进 brain / 出 brain）。
 * 名字就是 `<from>-to-<to>`，机械推导，不用记：
 *
 *   POST /human-to-brain   人类语音进，返回转录
 *   POST /brain-to-human   长轮询，取给人类的语音（文本 + 音频）
 *   POST /agent-to-brain   agent 文本进
 *   POST /brain-to-agent   长轮询，取 brain 下放给 agent 的文本
 *
 * 方向还预告了 HTTP 语义：**进 brain 的是提交，立即返回；出 brain 的是长轮询，
 * 可以空手而归**（`{"kind":"empty"}`）。所以四个端点里没有"哪个要不要等"这种要背的东西。
 *
 * 数据流（方括号是队列，队列本身归 brain 层）：
 *
 *   human-to-brain   ─▶ [人类 audio] ──STT──▶ [给 agent 的文本] ─▶ brain-to-agent
 *   agent-to-brain   ─▶ [agent 文本] ──TTS──▶ [agent 音频]     ─▶ brain-to-human
 *
 * body 有两种编码，带不带二进制说了算：
 *
 *   /human-to-brain、/brain-to-human   **只能 MessagePack**——body 里就是音频
 *   /agent-to-brain、/brain-to-agent   MessagePack 和 JSON 都收
 *
 * 带音频的 body 必须 MessagePack：bin 和结构化字段装在同一个对象里，不用 multipart、
 * 不用 base64。纯文本的 body 两种都行——JSON 让不装 msgpack 库的客户端也能直接调，
 * msgpack 一如既往。**agent 那对的响应跟着请求的编码走**（JSON 进 JSON 出，msgpack 进
 * msgpack 出），客户端不用另配 Accept。形状见 docs/brain-api.md。
 *
 * 错误一律用 HTTP 状态码 + `text/plain` 表达——错误体绝不能长得像**那个端点**的成功响应，
 * 否则会被当成一条合法回复去解。
 */
import { timingSafeEqual } from "node:crypto";
import { decode, encode } from "@msgpack/msgpack";
import { Hono } from "hono";
import { z } from "zod";

/** 两种 body 编码。错误一律 text/plain（见文件头）。 */
const MSGPACK = "application/msgpack";
const JSON_TYPE = "application/json";

/**
 * 路由需要 brain 提供的四件事，和四个端点一一同名。
 *
 * 名字不另起简称是有意的：`brain-to-agent` 这种名字本身已经把方向说全了，端口再换一套
 * 叫法（`nextSteer` 之类），接线时就得来回对表。
 *
 * 收的是**请求体**、回的是**响应体**（长轮询的两种返回就是那两个 body）。
 */
export interface BrainPorts {
  /**
   * `human-to-brain`：一段人类语音进，转录文本出——它就是响应体。
   *
   * **只有转写该拖住这个 Promise。** 进 history、跑模型、合成都是后台的事：
   * 用户每说一句都要等到整轮生成完才拿到文本的话，这个接口就白设计了。
   */
  humanToBrain(
    request: { brain_id: string; audio: Uint8Array },
    options: { signal: AbortSignal },
  ): Promise<{ kind: "text"; text: string }>;

  /**
   * `brain-to-human`：取 agent 要说的下一句（文本 + 它的语音）。
   *
   * **阻塞语义在这一层**：没话说就一直挂着，直到有话、`signal` 中止、或者客户端断开。
   * 中止时返回 `{ kind: "empty" }`，**不要抛**——"暂时没话说"是规格里最正常的一条路径，
   * 不是错误。
   */
  brainToHuman(
    request: { brain_id: string },
    options: { signal: AbortSignal },
  ): Promise<{ kind: "text"; text: string; audio: Uint8Array } | { kind: "empty" }>;

  /**
   * `agent-to-brain`：agent 把一段文本交给 brain。
   *
   * 不做长轮询——这是个写入，没有"等"的语义；等是出 brain 那两个端点的事。
   * 写入又没有可回报的产物，所以跟长轮询超时一样，ack 一个 `{ kind: "empty" }`。
   */
  agentToBrain(
    request: { brain_id: string; text: string },
    options: { signal: AbortSignal },
  ): Promise<{ kind: "empty" }>;

  /**
   * `brain-to-agent`：取 brain 下放给 agent 的下一段文本。多半是人类语音的转录，
   * 但也可能是别的东西（压缩后的 history、工具结果）——所以端口返回的是普通文本，
   * 不承诺它一定是转录。
   *
   * 阻塞语义同 `brainToHuman`：中止返回 `{ kind: "empty" }`，不要抛。
   */
  brainToAgent(
    request: { brain_id: string },
    options: { signal: AbortSignal },
  ): Promise<{ kind: "text"; text: string } | { kind: "empty" }>;
}

export interface RouterOptions {
  readonly ports: BrainPorts;
  /** 期望的 Bearer token。**空字符串 = 这个部署不启用鉴权**（规格 §0.2）。 */
  readonly token: string;
  /** 两个长轮询端点各挂多久返回 empty。 */
  readonly pollTimeoutMs: number;
}

// 请求体的形状。zod 只认解出来的对象，不管它来自 msgpack 还是 JSON——
// 两个 schema 在两种编码下都成立，只有音频字段是个 Uint8Array（msgpack 的 bin）。

const humanToBrainBody = z.object({
  brain_id: z.string().min(1),
  audio: z.instanceof(Uint8Array).refine((bytes) => bytes.length > 0),
});
const brainIdOnly = z.object({ brain_id: z.string().min(1) });
const agentToBrainBody = z.object({ brain_id: z.string().min(1), text: z.string().min(1) });

export function createBrainRouter(options: RouterOptions): Hono {
  const app = new Hono();

  app.use("*", async (c, next) => {
    if (!authorized(c.req.header("authorization"), options.token)) {
      return c.text("token 无效", 401);
    }
    await next();
  });

  // ── 人类那对：只能 MessagePack（body 里是音频，JSON 装不下）──────────────

  app.post("/human-to-brain", async (c) => {
    const parsed = humanToBrainBody.safeParse(await readMsgpack(c.req.raw));
    if (!parsed.success) return c.text("请求体要形如 { brain_id, audio }（MessagePack）", 400);

    try {
      return msgpack(await options.ports.humanToBrain(parsed.data, { signal: c.req.raw.signal }));
    } catch (cause) {
      console.error("[brains] human-to-brain 失败", cause);
      // 上游（STT）挂了是"网关那边的问题"，不是这个请求写错了。
      return c.text("转写失败", 502);
    }
  });

  app.post("/brain-to-human", async (c) => {
    const parsed = brainIdOnly.safeParse(await readMsgpack(c.req.raw));
    if (!parsed.success) return c.text("请求体要形如 { brain_id }（MessagePack）", 400);

    try {
      const reply = await poll(options.pollTimeoutMs, c.req.raw.signal, (signal) =>
        options.ports.brainToHuman(parsed.data, { signal }),
      );
      // 端口在中止时自己回 `{ kind: "empty" }`；undefined 只是它没守约定（抛了）时的兜底。
      return msgpack(reply ?? { kind: "empty" });
    } catch (cause) {
      console.error("[brains] brain-to-human 失败", cause);
      return c.text("取回复失败", 500);
    }
  });

  // ── agent 那对：JSON / MessagePack 都收，响应跟着请求 ───────────────────

  app.post("/agent-to-brain", async (c) => {
    const parsed = agentToBrainBody.safeParse(await readBody(c.req.raw));
    if (!parsed.success) return c.text("请求体要形如 { brain_id, text }", 400);

    try {
      // 写入没有可回报的产物，ack 一下。用 kind 是因为这套响应一直是 kind 判别的，
      // 客户端不用为这一条另写判据。
      return writeBody(
        c.req.raw,
        await options.ports.agentToBrain(parsed.data, { signal: c.req.raw.signal }),
      );
    } catch (cause) {
      console.error("[brains] agent-to-brain 失败", cause);
      return c.text("处理失败", 500);
    }
  });

  app.post("/brain-to-agent", async (c) => {
    const parsed = brainIdOnly.safeParse(await readBody(c.req.raw));
    if (!parsed.success) return c.text("请求体要形如 { brain_id }", 400);

    try {
      const reply = await poll(options.pollTimeoutMs, c.req.raw.signal, (signal) =>
        options.ports.brainToAgent(parsed.data, { signal }),
      );
      return writeBody(c.req.raw, reply ?? { kind: "empty" });
    } catch (cause) {
      console.error("[brains] brain-to-agent 失败", cause);
      return c.text("取文本失败", 500);
    }
  });

  return app;
}

/** 成功响应：MessagePack 编一个对象出去。 */
function msgpack(value: unknown): Response {
  return new Response(encode(value), { headers: { "content-type": MSGPACK } });
}

/** 成功响应：JSON 编一个对象出去。 */
function json(value: unknown): Response {
  return new Response(JSON.stringify(value), { headers: { "content-type": JSON_TYPE } });
}

/**
 * 读一个 MessagePack 请求体。解不出来（不是 msgpack、空 body、截断）就交回 undefined，
 * 由调用点的 safeParse 判成 400——读请求体本身不是这个层要区分失败原因的地方。
 */
async function readMsgpack(request: Request): Promise<unknown> {
  try {
    return decode(new Uint8Array(await request.arrayBuffer()));
  } catch {
    return undefined;
  }
}

/** 读一个 JSON 请求体。解析不出来（空 body、语法错）也交回 undefined，同 readMsgpack。 */
async function readJson(request: Request): Promise<unknown> {
  try {
    return JSON.parse(await request.text());
  } catch {
    return undefined;
  }
}

/**
 * 读 agent 那对的请求体：`application/json` 走 JSON，其余走 MessagePack。
 * 两种都收，所以认不出的 Content-Type 也当 MessagePack 试一把——老客户端未必带这个头。
 */
function readBody(request: Request): Promise<unknown> {
  return mediaType(request) === JSON_TYPE ? readJson(request) : readMsgpack(request);
}

/** 编 agent 那对的响应：跟着请求的编码走——JSON 进 JSON 出，msgpack 进 msgpack 出。 */
function writeBody(request: Request, value: unknown): Response {
  return mediaType(request) === JSON_TYPE ? json(value) : msgpack(value);
}

/** Content-Type 的媒体类型部分（去掉 `; charset=...`）。 */
function mediaType(request: Request): string {
  const raw = request.headers.get("content-type") ?? "";
  const end = raw.indexOf(";");
  return (end === -1 ? raw : raw.slice(0, end)).trim();
}

/**
 * 两个长轮询端点的公共部分：把超时和客户端断开合成一个 signal 递进去，取件。
 *
 * 超时/断开本该由端口自己归一成 `{ kind: "empty" }`（见 BrainPorts）。这里再兜一层：
 * 端口实现就算把 AbortError 抛出来（没守约定），也不该把一个正常的空轮询变成 5xx——
 * 所以中止之后一律交回 undefined，由调用点补成 empty。
 *
 * 合成放在这里而不是 brain 层，是因为"挂多久"是 HTTP 的关切，brain 只需要知道该等多久。
 */
async function poll<T>(
  timeoutMs: number,
  requestSignal: AbortSignal,
  take: (signal: AbortSignal) => Promise<T>,
): Promise<T | undefined> {
  const signal = AbortSignal.any([AbortSignal.timeout(timeoutMs), requestSignal]);
  try {
    return await take(signal);
  } catch (cause) {
    if (signal.aborted) return undefined;
    throw cause;
  }
}

/**
 * 鉴权。
 *
 * **token 为空表示部署方没启用鉴权**，直接放行——规格 §0.2 特意说了客户端在 token 为空时
 * 不发 Authorization 头，所以这里不能把"没有这个头"一律判成失败。
 */
function authorized(header: string | undefined, expected: string): boolean {
  if (expected === "") return true;
  if (header === undefined) return false;
  if (!header.startsWith("Bearer ")) return false;

  const given = Buffer.from(header.slice("Bearer ".length), "utf8");
  const want = Buffer.from(expected, "utf8");
  // timingSafeEqual 要求等长，长度不等直接判否——长度本来就会从响应时间上漏出去，
  // 给它多走一次比较也是白走。
  return given.length === want.length && timingSafeEqual(given, want);
}
