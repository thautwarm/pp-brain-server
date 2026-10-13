import assert from "node:assert/strict";
import { test } from "node:test";

import { ChatAgent, IntelligenceError } from "./index.ts";

// 公开面冒烟：证明包能被 import、命名空间挂载齐全。
// 注意本包迁移过来时自带的 test/ 目录是空的，这些是补的第一批测试。
test("公开面：ChatAgent 的命名空间都在", () => {
  assert.equal(typeof ChatAgent.append, "function");
  assert.equal(typeof ChatAgent.request, "function");
  assert.equal(typeof ChatAgent.tools.pending, "function");
  assert.equal(typeof ChatAgent.chunks.toHttpResponse, "function");
  assert.equal(typeof ChatAgent.chunks.fromHttpResponse, "function");
  assert.equal(typeof ChatAgent.chunks.readMessages, "function");
});

test("IntelligenceError：携带 code，并保留 cause", () => {
  const cause = new Error("底层原因");
  const error = new IntelligenceError({ code: "invalid-chunk-stream" }, { cause });

  assert.ok(error instanceof Error);
  assert.equal(error.code, "invalid-chunk-stream");
  assert.equal(error.cause, cause);
});

test("chunks：服务端响应 → 客户端 chunk 流，来回收得回来", async () => {
  const message = {
    id: "m1",
    role: "user" as const,
    parts: [{ type: "text" as const, text: "你好" }],
  };

  // 真跑一次：构造 chunk 流 → 转成 HTTP 响应 → 客户端解回来
  const response = ChatAgent.chunks.toHttpResponse(
    new ReadableStream({
      start(controller) {
        controller.enqueue({ type: "start", messageId: message.id });
        controller.enqueue({ type: "text-start", id: "t1" });
        controller.enqueue({ type: "text-delta", id: "t1", delta: "你好" });
        controller.enqueue({ type: "text-end", id: "t1" });
        controller.enqueue({ type: "finish" });
        controller.close();
      },
    }),
  );

  const decoded: string[] = [];
  for await (const chunk of ChatAgent.chunks.fromHttpResponse(response)) {
    decoded.push(chunk.type);
  }

  assert.deepEqual(decoded, ["start", "text-start", "text-delta", "text-end", "finish"]);
});
