# @might/chat-core

[English](./README.en.md) | 中文

模型会话的**事实层**：应用侧的消息、工具调用，和一轮模型推进。

- 会话事实只有一种：`UIMessage`。落库、传输、模块间契约都用它。
- AI SDK 面向 provider 的 `ModelMessage` 只在真正发请求那一刻投影出来，用完即弃。
- 一轮 = 一次 `ChatAgent.request`，只推进一步、只产出一条 assistant 消息。要不要继续，由应用决定。
- `ChatAgent` 是一个命名空间，不是能创建的对象；底下全是无状态函数，没有实例和配置。

上游依赖锁 `ai@7.0.101`。实现放在 `implementation/` 下，形状和公开面一致：顶层直挂的写在实现层的
`index`，带子命名空间的各占一个文件。

## 最小用法（服务端）

```ts
import { ChatAgent } from "@might/chat-core";

const conversation = {
  messages: [
    { id: "m1", role: "user", parts: [{ type: "text", text: "你好" }] },
  ],
};

const run = ChatAgent.request({ conversation, model });

// 传输面：chunk 流 → SSE 响应
return ChatAgent.chunks.toHttpResponse(run.chunks);

// 事实面：这一轮的那一条 assistant 消息
const message = await run.result;
const next = ChatAgent.append(conversation, message);
```

`run.result` 在流被消费时定终态，所以「一边回传、一边落库」是同一个流的两面，不需要读两遍。

## 过 HTTP：`ChatAgent.chunks`

`ChatAgent.request` 交出来的是 chunk 流，不绑定传输。走 HTTP 时，两端各一次转换：

```ts
// 服务端：chunk 流编码成 SSE 响应
return ChatAgent.chunks.toHttpResponse(run.chunks);

// 客户端：响应还原成同一种 chunk 流
const chunks = ChatAgent.chunks.fromHttpResponse(response);
```

两端是同一套 SSE 编码：服务端逐条写 `data: {...}\n\n`、以 `data: [DONE]` 收尾；客户端按
`uiMessageChunkSchema` 逐条解析，`[DONE]` 自动跳过。往返后 chunk 序列不变。

## 客户端：chunk 进，消息出

```ts
for await (const message of ChatAgent.chunks.readMessages(chunkStream)) {
  render(message); // 每次都是当前这条消息的完整快照
}
```

同一条消息会 yield 多次，`id` 不变、parts 逐步长齐，不需要自己拼 delta。`chunkStream` 由上一节的
`ChatAgent.chunks.fromHttpResponse` 还原得到，是 `ReadableStream<UIMessageChunk>`；应用侧看不到
chunk。

## 模型和参数从哪来

模型实例、`generation`、`providerOptions` 由调用方解析好，原样交给这一层：

```ts
const run = ChatAgent.request({
  conversation,
  model,
  generation,
  providerOptions,
  estimatePrice, // 可选：拿到 usage 之后算一次
});
```

`estimatePrice` 接收 `usage`，结果写入消息的 `metadata.estimatedPrice`。估价失败记录
`{ errors }`，不影响生成结果；未提供估价函数或没有 `usage` 时，不写这个字段。

那 `usage` 是什么：AI SDK 的 `LanguageModelUsage`，加上我们记的媒体用量——`usage.image` /
`usage.video` / `usage.audio`，每侧都是 `{ input?, output? }` 的数组，一件产物一条。

## 工具调用

```ts
import { z } from "zod";

const tools = {
  weather: {
    description: "查天气",
    inputSchema: z.object({ city: z.string() }),
  },
};

const run = ChatAgent.request({ conversation, model, tools });
const message = await run.result;
const next = ChatAgent.append(conversation, message);

// 模型发了、应用还没给结果的调用
const calls = ChatAgent.tools.pending(next);

// 校验：有类型那条路
for (const call of await ChatAgent.tools.validateTyped(calls, { tools })) {
  if (call.kind === "invalid") report(call.diagnostic.issues); // 诊断是返回值，不是异常
  if (call.kind === "closed" && call.toolName === "weather") {
    call.input.city; // string
  }
}

// 补上结果，再推进一轮
const answered = ChatAgent.tools.complete(next, [{ toolCallId, output }]);
const second = ChatAgent.request({ conversation: answered, model, tools });
```

`request` 忽略工具定义里的 `execute` 和 `needsApproval`：交给模型的工具里没有这两个字段，
模型发起的调用只会停在 `input-available`，执行和审批都归应用。

校验要有能真正执行的 schema：zod、Standard Schema、带 `validate` 的 `jsonSchema` 都行；只给一份 JSON
Schema 描述（没有可执行的校验函数）拿不到校验能力，那条调用会被判 `invalid`。

校验结果三态：

| kind      | 含义                                               |
| --------- | -------------------------------------------------- |
| `closed`  | 静态工具、输入通过校验，`input` 由 schema 推出类型 |
| `open`    | 只给了 `openTools` 的运行时工具，输入保持 unknown  |
| `invalid` | 未知工具或输入不合法，`diagnostic` 带问题清单      |

`ChatAgent.tools.validate` 是同一件事的无类型入口：工具定义在运行时才拿到时用它，`closed` 的 `input`
只能是 unknown。

## 存取

```ts
const wire = ChatAgent.codec.serialize(conversation);
const back = await ChatAgent.codec.deserialize(wire); // 版本不符或结构不合法 fail-closed
```

`ChatAgent.codec.version` 就是当前的格式版本号。这一层只管格式，不管是落库还是走别的通道。

## 不做什么

- 不做循环、不做调度：一轮一次调用，继续与否归应用。
- 不执行工具、不审批、不管副作用。
- 不存储、不加密、不定保留期限。
- 不碰 base URL、凭据、模型选择：那是上层的事。
