/**
 * 传输面：chunk 流与网络响应之间的转换。
 *
 * 不解释 chunk 的内容，只做编码和还原。解码失败一律包成 IntelligenceError，
 * 底层原因挂在 cause 上，别让调用方在两种错误类型之间猜。
 */
import {
  type AsyncIterableStream,
  createUIMessageStreamResponse,
  parseJsonEventStream,
  readUIMessageStream,
  type UIMessage,
  type UIMessageChunk,
  uiMessageChunkSchema,
} from "ai";

import { IntelligenceError } from "../index.ts";

/** 服务端：chunk 流 → 逐条 `data: {...}`、以 `data: [DONE]` 收尾的响应。 */
export function toHttpResponse(chunks: ReadableStream<UIMessageChunk>): Response {
  return createUIMessageStreamResponse({ stream: chunks });
}

/** 客户端：响应 → 同一种 chunk 流；解析失败项包成 IntelligenceError 抛出。 */
export function fromHttpResponse(response: Response): ReadableStream<UIMessageChunk> {
  if (!response.body) {
    throw new IntelligenceError({
      code: "invalid-chunk-stream",
      field: "body",
    });
  }
  return parseJsonEventStream({
    stream: response.body,
    schema: uiMessageChunkSchema,
  }).pipeThrough(
    new TransformStream({
      transform(chunk, controller) {
        if (!chunk.success) {
          throw new IntelligenceError({ code: "invalid-chunk-stream" }, { cause: chunk.error });
        }
        controller.enqueue(chunk.value);
      },
    }),
  );
}

/**
 * 应用面：chunk 流 → 消息快照流。同一个 id 逐步长出来，每次都是完整消息，
 * 不是 delta；具体收成哪种消息由公开面绑定。
 *
 * terminateOnError 必须显式打开：上游这个选项默认是 false，出错时会静默地把流结束掉，
 * 调用方拿到的是「正常读完了、只是没有消息」。失败要说失败。
 */
export function readMessages<MESSAGE extends UIMessage>(
  stream: ReadableStream<UIMessageChunk>,
): AsyncIterableStream<MESSAGE> {
  return readUIMessageStream<MESSAGE>({ stream, terminateOnError: true });
}
