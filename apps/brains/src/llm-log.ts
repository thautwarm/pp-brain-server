/**
 * 把发往 chat 模型的 HTTP 请求/响应落到文件里（`MIGHT_LOG_LLM=1` 时开启）。
 *
 *   logs/revise/<YYYY-MM-DD>/<uuid>/request.json
 *   logs/revise/<YYYY-MM-DD>/<uuid>/response.json
 *
 * 为什么 hook `fetch`：AI SDK 把请求体、SSE 增量都封在内部，只有网络这一层能拿到"真正发出去
 * 的字节"和"真正回来的字节"。这里只做透明转发，不解析、不改写。
 *
 * 默认关闭——body 里是完整对话内容。响应单条最多记 {@link MAX_RESPONSE_CHARS} 个字符。
 */
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";

/** 响应体最多记多少字符（SSE 累加后）。 */
const MAX_RESPONSE_CHARS = 4_000_000;

/** 落盘根目录；compose 里挂到宿主，容器重建不会丢。 */
function root(): string {
  return path.resolve(process.env.MIGHT_LOG_LLM_DIR ?? "logs");
}

/** 从流里读完整响应（有上限），然后放手（不拖住原始响应）。 */
async function drain(response: Response): Promise<string> {
  if (response.body === null) return "";

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let out = "";

  try {
    while (out.length < MAX_RESPONSE_CHARS) {
      const { done, value } = await reader.read();
      if (done) break;
      out += decoder.decode(value, { stream: true });
    }
  } catch {
    // 记日志本身不该抛；读一半断了就记已经读到的。
  } finally {
    await reader.cancel().catch(() => {});
  }

  return out.length >= MAX_RESPONSE_CHARS ? `${out}…（截断）` : out;
}

/** 头里只留有用的，`authorization` 打码。 */
type HeaderInit = ConstructorParameters<typeof Headers>[0];

function safeHeaders(headers: HeaderInit | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  if (headers === undefined) return out;

  for (const [key, value] of new Headers(headers)) {
    out[key] = key.toLowerCase() === "authorization" ? "Bearer ***" : value;
  }
  return out;
}

/** 装一个只对 chat 端点生效的 fetch 钩子。没开或没配 baseURL 时什么都不做。 */
export function installLlmLogger(): void {
  const base = process.env.MIGHT_CHAT_API_BASE_URL;
  if (process.env.MIGHT_LOG_LLM !== "1" || base === undefined || base === "") return;

  const original = globalThis.fetch;

  globalThis.fetch = async (input, init) => {
    const url = input instanceof Request ? input.url : String(input);
    if (!url.startsWith(base)) return original(input, init);

    const id = randomUUID();
    const startedAt = new Date();
    const day = startedAt.toISOString().slice(0, 10);
    // 目前只有纠偏会打 chat 模型，所以固定归到 revise 下；多一种用途时再细分。
    const dir = path.join(root(), "revise", day, id);
    const started = Date.now();

    const method = init?.method ?? (input instanceof Request ? input.method : "GET");
    const rawBody = typeof init?.body === "string" ? init.body : "";
    let requestBody: unknown = rawBody;
    try {
      requestBody = JSON.parse(rawBody);
    } catch {
      // 不是 JSON 就按字符串记。
    }

    void (async () => {
      try {
        await mkdir(dir, { recursive: true });
        await writeFile(
          path.join(dir, "request.json"),
          JSON.stringify(
            { id, at: startedAt.toISOString(), method, url, headers: safeHeaders(init?.headers), body: requestBody },
            null,
            2,
          ),
        );
      } catch (error) {
        console.error(`[llm] 写 request.json 失败`, error);
      }
    })();

    const res = await original(input, init);

    // clone 之后再读：不消费原始流，流式的 SSE 也不会被拖慢。
    const clone = res.clone();
    void drain(clone)
      .then(async (text) => {
        let responseBody: unknown = text;
        try {
          responseBody = JSON.parse(text);
        } catch {
          // SSE / 非 JSON：原样记字符串。
        }

        console.log(`[llm] ${id} ${res.status} ${Date.now() - started}ms`);
        await mkdir(dir, { recursive: true });
        await writeFile(
          path.join(dir, "response.json"),
          JSON.stringify(
            {
              id,
              status: res.status,
              durationMs: Date.now() - started,
              headers: safeHeaders(res.headers),
              body: responseBody,
            },
            null,
            2,
          ),
        );
      })
      .catch((error) => console.error(`[llm] 写 response.json 失败`, error));

    return res;
  };
}
