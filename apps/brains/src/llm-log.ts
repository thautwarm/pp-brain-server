/**
 * 把发往 chat 模型的 HTTP 请求/响应原样记下来（`MIGHT_LOG_LLM=1` 时开启）。
 *
 * 为什么 hook `fetch`：AI SDK 把请求体、SSE 增量都封在内部，只有网络这一层能拿到"真正发出去
 * 的字节"和"真正回来的字节"。这里只做透明转发，不解析、不改写。
 *
 * 默认关闭——body 里是完整对话内容。单条最多记 {@link MAX_BYTES} 个字符，剩下的截断。
 */

/** 单条日志的上限（字符）。**请求和响应各自独立计时**。 */
const MAX_BYTES = 8_000;

/** 从流里读最多 `MAX_BYTES` 个字符，然后放手（不拖住原始响应）。 */
async function drain(response: Response): Promise<string> {
  if (response.body === null) return "";

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let out = "";

  try {
    while (out.length < MAX_BYTES) {
      const { done, value } = await reader.read();
      if (done) break;
      out += decoder.decode(value, { stream: true });
    }
  } catch {
    // 记日志本身不该抛；读一半断了就记已经读到的。
  } finally {
    await reader.cancel().catch(() => {});
  }

  return out.length > MAX_BYTES ? `${out.slice(0, MAX_BYTES)}…（截断）` : out;
}

/** 装一个只对 chat 端点生效的 fetch 钩子。没开或没配 baseURL 时什么都不做。 */
export function installLlmLogger(): void {
  const base = process.env.MIGHT_CHAT_API_BASE_URL;
  if (process.env.MIGHT_LOG_LLM !== "1" || base === undefined || base === "") return;

  const original = globalThis.fetch;

  globalThis.fetch = async (input, init) => {
    const url = input instanceof Request ? input.url : String(input);
    if (!url.startsWith(base)) return original(input, init);

    const started = Date.now();
    const method = init?.method ?? (input instanceof Request ? input.method : "GET");
    const body =
      typeof init?.body === "string" ? init.body : init?.body == null ? "" : "<非文本 body>";

    console.log(`[llm] >>> ${method} ${url} ${body.slice(0, MAX_BYTES)}`);

    const res = await original(input, init);

    // clone 之后再读：不消费原始流，流式的 SSE 也不会被拖慢。
    const clone = res.clone();
    void drain(clone).then((text) => {
      console.log(`[llm] <<< ${res.status} ${Date.now() - started}ms ${text}`);
    });

    return res;
  };
}
