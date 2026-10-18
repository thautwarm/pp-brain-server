/**
 * Brain API 的 HTTP 层：四个端点、鉴权、请求校验、长轮询与分帧流。
 *
 * 这一层只认协议，不认 brain：队列、转写、模型、合成都归 brain 层。两边靠 BrainPorts
 * 这唯一的缝隔开——所以这个文件不 import @might/chat / @might/audio 的任何东西，
 * 反过来 brain 层也不必知道 HTTP 长什么样。
 *
 * 四个端点刚好是一张 2×2：谁（human / agent）× 方向（进 brain / 出 brain）。
 * 名字就是 `<from>-to-<to>`，机械推导，不用记：
 *
 *   POST /human-to-brain   人类语音进，返回转录
 *   POST /brain-to-human   长轮询，取给人类的语音（分帧流：文本 + 音频）
 *   POST /agent-to-brain   agent 文本进
 *   POST /brain-to-agent   长轮询，取 brain 下放给 agent 的文本
 *
 * 方向还预告了 HTTP 语义：**进 brain 的是提交，立即返回；出 brain 的是长轮询，
 * 可以空手而归**（`{"kind":"empty"}`；`/brain-to-human` 的那一个在帧流里）。
 * 所以四个端点里没有"哪个要不要等"这种要背的东西。
 *
 * 数据流（方括号是队列，队列本身归 brain 层）：
 *
 *   human-to-brain   ─▶ [人类 audio] ──STT──▶ [给 agent 的文本] ─▶ brain-to-agent
 *   agent-to-brain   ─▶ [agent 文本] ─(请求内 TTS)─▶ brain-to-human
 *
 * body 有两种编码，带不带二进制说了算：
 *
 *   /human-to-brain、/brain-to-human   **只能 MessagePack**——body 里就是音频
 *   /agent-to-brain、/brain-to-agent   MessagePack 和 JSON 都收
 *
 * 带音频的 body 必须 MessagePack：bin 和结构化字段装在同一个对象里，不用 multipart、
 * 不用 base64。纯文本的 body 两种都行——JSON 让不装 msgpack 库的客户端也能直接调，
 * msgpack 一如既往。**agent 那对的响应跟着请求的编码走**（JSON 进 JSON 出，msgpack 进
 * msgpack 出），客户端不用另配 Accept。形状见 docs/brain-api-spec.md。
 *
 * 错误一律用 HTTP 状态码 + `text/plain` 表达——错误体绝不能长得像**那个端点**的成功响应，
 * 否则会被当成一条合法回复去解。**`brain_id` 不再是白名单**：任何非空字符串都会现建一个
 * brain，所以没有"没有这个 brain"这条失败路径。
 */
import { timingSafeEqual } from "node:crypto";
import { decode, encode } from "@msgpack/msgpack";
import { type Context, Hono } from "hono";
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
   *
   * `unheard_text` 是打断时补上来的那段——agent 已经说出来、人类没听到的话。**可空**，
   * 没有就当它不存在。
   *
   * `voice` 来自 `x-brain-voice` 头（旧名 `x-might-voice`）。路由**原样递下来**，用不用
   * 是 brain 的事：这个端点本身不合成语音，所以目前它不影响任何行为。
   */
  humanToBrain(
    request: { brain_id: string; audio: Uint8Array; unheard_text?: string | null; voice?: string },
    options: { signal: AbortSignal },
  ): Promise<{ kind: "text"; text: string }>;

  /**
   * `brain-to-human`：取 agent 要说的下一句，以及它的语音。
   *
   * 等不到内容（`waitMs` 用完）返回 `{ kind: "empty" }`；否则返回这一条文本 + 一个 Ogg 字节流
   * （可能为空：整条被静音、或被客户端跳过）。断连由 `signal` 传进来，实现要立刻停手。
   *
   * 合成在**返回之前**就打开：打不开（音色不存在、TTS 挂了）就抛，路由回 `502`，消息放回队列。
   */
  brainToHuman(
    /**
     * `skip_before`（可选，UTC epoch 毫秒，**客户端的钟**）：早于这个时刻入队的 agent 消息
     * 不算语音，只回文本并标 `skipped`（语义见规格 §3.2）。
     */
    request: { brain_id: string; skip_before?: number },
    options: { signal: AbortSignal; waitMs: number },
  ): Promise<
    | { kind: "empty" }
    | {
        kind: "speech";
        /** 这条回复的**原始**文本（`<!-- disable voice -->` 段原样保留）。 */
        text: string;
        /** 客户端用 `skip_before` 跳过的旧消息：只回文本，没有音频。 */
        skipped: boolean;
        audio: AsyncIterable<Uint8Array>;
      }
  >;

  /**
   * `agent-to-brain`：agent 把一段文本交给 brain。
   *
   * 不做长轮询——这是个写入，没有"等"的语义；等是出 brain 那两个端点的事。
   * 写入又没有可回报的产物，所以跟长轮询超时一样，ack 一个 `{ kind: "empty" }`。
   *
   * `voice` 来自 `x-brain-voice` 头（旧名 `x-might-voice`），**只作用于这一条消息**：音色是
   * per-request 的，brain 上不存；不带就用部署级的 `TTS_VOICE`。
   */
  agentToBrain(
    request: { brain_id: string; text: string; voice?: string },
    options: { signal: AbortSignal },
  ): Promise<{ kind: "empty" }>;

  /**
   * `brain-to-agent`：取 brain 下放给 agent 的下一段文本。多半是人类语音的转录，
   * 但也可能是别的东西（压缩后的 history、工具结果）——所以端口返回的是普通文本，
   * 不承诺它一定是转录。
   *
   * 阻塞语义同旧的长轮询：中止返回 `{ kind: "empty" }`，不要抛。
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
  /** 长轮询等多久（`/brain-to-human` 只等到有内容；之后音频是流式的）。 */
  readonly pollTimeoutMs: number;
}

// 请求体的形状。zod 只认解出来的对象，不管它来自 msgpack 还是 JSON——
// 两个 schema 在两种编码下都成立，只有音频字段是个 Uint8Array（msgpack 的 bin）。

const humanToBrainBody = z.object({
  brain_id: z.string().min(1).max(64),
  audio: z.instanceof(Uint8Array).refine((bytes) => bytes.length > 0),
  /**
   * 人类打断时"没听到的那段"（agent 已经说出来、但没播完的话）。
   *
   * **可空**：不给、给 `null`、给空串，都算"这次没有"；给了就插到给 agent 的文本前面
   * （见 brain-center）。
   */
  unheard_text: z.string().nullish(),
});
const brainIdOnly = z.object({ brain_id: z.string().min(1).max(64) });
/** `/brain-to-human` 可以带一个 UTC 毫秒时间戳：早于它入队的消息直接丢。 */
const brainToHumanBody = z.object({
  brain_id: z.string().min(1).max(64),
  // 上限是 Date 能表示的范围：再大 `new Date()` 会直接抛。
  skip_before: z.number().int().nonnegative().max(8_640_000_000_000_000).nullish(),
});
const agentToBrainBody = z.object({
  brain_id: z.string().min(1).max(64),
  text: z.string().min(1),
});

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
      return msgpack(
        await options.ports.humanToBrain(
          { ...parsed.data, ...voiceOf(c) },
          { signal: c.req.raw.signal },
        ),
      );
    } catch (cause) {
      return fault(c, cause, "转写失败", 502);
    }
  });

  app.post("/brain-to-human", async (c) => {
    const parsed = brainToHumanBody.safeParse(await readMsgpack(c.req.raw));
    if (!parsed.success) {
      return c.text("请求体要形如 { brain_id, skip_before? }（MessagePack）", 400);
    }

    let reply: Awaited<ReturnType<BrainPorts["brainToHuman"]>>;
    try {
      reply = await options.ports.brainToHuman(
        { brain_id: parsed.data.brain_id, skip_before: parsed.data.skip_before ?? undefined },
        { signal: c.req.raw.signal, waitMs: options.pollTimeoutMs },
      );
    } catch (cause) {
      // 还没往客户端发任何字节：消息在端口里已经放回队列，这里只报错。
      return fault(c, cause, "取回复失败", 502);
    }

    return speechResponse(parsed.data.brain_id, reply);
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
        await options.ports.agentToBrain(
          { ...parsed.data, ...voiceOf(c) },
          { signal: c.req.raw.signal },
        ),
      );
    } catch (cause) {
      return fault(c, cause, "处理失败", 500);
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
      return fault(c, cause, "取文本失败", 500);
    }
  });

  return app;
}

/**
 * 端口抛错时的统一出口：记日志、回一句 `text/plain`。
 *
 * `brain_id` 不再是白名单，所以没有"没有这个 brain"这条失败路径了 —— 任何名字都会现建一个。
 */
function fault(c: Context, cause: unknown, message: string, status: 500 | 502): Response {
  console.error(`[brains] ${message}`, cause);
  return c.text(message, status);
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
 * 语音响应的前导：`[u32 大端 文本长度][UTF-8 文本][1 字节标志]`，后面直接跟 Ogg Opus。
 *
 * 标志只有最低位有定义：`1` = 这条被客户端 `skip_before` 跳过（body 里不会有音频）。
 * 文本长度为 0 = 这一轮没有内容（客户端立刻重发）。
 */
function speechPrelude(text: string, skipped: boolean): Uint8Array<ArrayBuffer> {
  const bytes = new TextEncoder().encode(text);
  const out = new Uint8Array(4 + bytes.length + 1);
  new DataView(out.buffer).setUint32(0, bytes.length);
  out.set(bytes, 4);
  out[4 + bytes.length] = skipped ? 1 : 0;
  return out;
}

/** 前导 + Ogg 流拼成一个响应体；音频来一块转发一块。 */
function speechResponse(
  brainId: string,
  reply: Awaited<ReturnType<BrainPorts["brainToHuman"]>>,
): Response {
  const head =
    reply.kind === "empty" ? speechPrelude("", false) : speechPrelude(reply.text, reply.skipped);

  if (reply.kind === "empty") {
    console.log(`[b2h] ${briefId(brainId)} empty`);
    return speechBody(head);
  }

  const startedAt = Date.now();
  let sent = head.length;
  const iterator = reply.audio[Symbol.asyncIterator]();

  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(head);
    },
    async pull(controller) {
      try {
        const next = await iterator.next();
        if (next.done) {
          console.log(
            `[b2h] ${briefId(brainId)} ${reply.skipped ? "skipped" : "speech"} ${reply.text.length} 字 ${sent}B ${Date.now() - startedAt}ms`,
          );
          controller.close();
          return;
        }
        sent += next.value.length;
        controller.enqueue(next.value);
      } catch {
        // 客户端断开、或 TTS 中途挂了：字节流到此为止（状态码早就发出去了）。
        console.log(`[b2h] ${briefId(brainId)} 中断 ${sent}B ${Date.now() - startedAt}ms`);
        await iterator.return?.(undefined);
        controller.close();
      }
    },
    async cancel() {
      console.log(`[b2h] ${briefId(brainId)} 客户端断开 ${sent}B ${Date.now() - startedAt}ms`);
      await iterator.return?.(undefined);
    },
  });

  return speechBody(body);
}

/** 前导 + （可选）音频流包成一个响应。 */
function speechBody(body: ReadableStream<Uint8Array> | Uint8Array<ArrayBuffer>): Response {
  return new Response(body, {
    // 不是 audio/ogg：body 前面还有前导。x-accel-buffering 让反代别攒包。
    headers: {
      "content-type": "application/octet-stream",
      "cache-control": "no-store",
      "x-accel-buffering": "no",
    },
  });
}

/** 日志里的 brain_id：截断 + 引号，防止伪造日志行。 */
function briefId(brainId: string): string {
  return JSON.stringify(brainId.length > 40 ? `${brainId.slice(0, 40)}…` : brainId);
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
 * 可选的音色头：这条请求要用什么音色。两个提交端点都往下递，只有 `/agent-to-brain` 上的
 * 会影响合成——音色是 per-request 的，跟着那条消息进队列。
 *
 * 两个名字都认，`x-brain-voice` 优先（更具体），`x-might-voice` 是旧名。空串和缺省一样，算没带。
 *
 * 返回的是可以直接展开进请求对象的片段（没带就是空对象）——这样端口收到的 request 里
 * 不会多出一个值为 `undefined` 的 `voice` 键。
 */
function voiceOf(c: Context): { voice?: string } {
  const voice = (c.req.header("x-brain-voice") ?? c.req.header("x-might-voice"))?.trim();
  return voice === undefined || voice === "" ? {} : { voice };
}

/**
 * `/brain-to-agent` 的长轮询：把超时和客户端断开合成一个 signal 递进去，取件。
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
