/**
 * 实现层入口：按方面拆开的实现在这里汇总。
 *
 * 这一层的形状和公开面（src/index.ts）的 CoreAgent 命名空间对齐：顶层是什么，这里就是
 * 什么。所以顶层直接挂着的 append 就写在这里，不为一行函数单开文件；带子命名空间的
 * 那几个才各占一个文件，通过命名空间转出去。
 *
 * 这里是循环引用（index → implementation → index 取 IntelligenceError），安全的前提是
 * 实现层只在函数体里用公开面的类，不在模块顶层 new：模块求值顺序决定顶层那会儿绑定
 * 还没初始化。要引类就这么引，别再为此把公开类型拆出 index.ts。
 */
import {
  asSchema,
  convertToModelMessages,
  createUIMessageStream,
  dynamicTool,
  type FlexibleSchema,
  generateId,
  isStepCount,
  type JSONSchema7,
  jsonSchema,
  streamText,
  toUIMessageStream,
} from "ai";
import type {
  AgentRequestOptions,
  AgentRun,
  ApplicationMessage,
  Conversation,
  LanguageModel,
  MediaUsage,
  MessageMetadata,
  MessagePriceEstimation,
  MessageUsage,
  ToolSet,
} from "../index.ts";
import { CORRECT_AI_NAMESPACE, IntelligenceError } from "../index.ts";

/** 在会话末尾追加一条消息，返回新会话，不改动原对象和原数组。 */
export function append<TOOLS extends ToolSet>(
  conversation: Conversation<TOOLS>,
  message: ApplicationMessage<TOOLS>,
): Conversation<TOOLS> {
  return {
    ...conversation,
    messages: [...conversation.messages, message],
  };
}

/**
 * 推进一轮模型请求：把会话投影成模型消息、跑一步、把结果同时给成 chunk 流和一条消息。
 *
 * 几个刻意的选择：
 * - 单步是显式写出来的（stopWhen 默认也是这个值）：一轮只推进一步，循环归应用。
 * - 工具不执行、也不审批：交给上游的 tools 先摘掉 execute 和 needsApproval，模型发起的
 *   调用只会停在 input-available，接着用 CoreAgent.tools 处理。
 * - abort 归我们：上游的 StreamTextResult 没有 abort 方法，只能给它 signal，所以这里
 *   自己拿一个 controller，跟调用方传进来的 signal 合并。取消 chunks（reader.cancel()
 *   或消费者提前退出）走同一条路：底层请求跟着中止，result 以 aborted 拒绝。
 * - 出错不静默：createUIMessageStream 的 onError 默认把一切都压成一句泛话，这里既把
 *   真因挂到 result 的拒绝上，也接管给客户端的那句话。
 * - result 是 Promise：只读 chunks 的人不该被未处理的 rejection 打扰，所以内部先兜一层；
 *   真去 await 的照样拿到失败。
 */
export function request<TOOLS extends ToolSet = ToolSet>(
  options: AgentRequestOptions<TOOLS>,
): AgentRun<TOOLS> {
  const download = options.download;
  const toolNames = [
    ...Object.keys(options.tools ?? {}),
    ...(options.openTools ?? []).map((tool) => tool.name),
    ...(options.activeTools ?? []),
    ...(typeof options.toolChoice === "object" ? [options.toolChoice.toolName] : []),
  ];
  if (toolNames.some((name) => name.startsWith("__") && name.endsWith("__"))) {
    throw new RangeError("tool names matching __...__ are reserved");
  }
  const controller = new AbortController();
  const abortSignal =
    options.abortSignal === undefined
      ? controller.signal
      : AbortSignal.any([options.abortSignal, controller.signal]);

  let settle!: (message: ApplicationMessage<TOOLS>) => void;
  let fail!: (error: unknown) => void;
  const result = new Promise<ApplicationMessage<TOOLS>>((resolve, reject) => {
    settle = resolve;
    fail = reject;
  });
  void result.catch(() => {});

  const modelTools: ToolSet = {};
  for (const [name, tool] of Object.entries(options.tools ?? {})) {
    // request 只生成事实：执行和审批都是调用方的事，别把上游的执行/审批钩子交出去。
    modelTools[name] =
      "execute" in tool || "needsApproval" in tool
        ? { ...tool, execute: undefined, needsApproval: undefined }
        : tool;
  }
  for (const openTool of options.openTools ?? []) {
    if (Object.hasOwn(modelTools, openTool.name)) continue;
    // 运行时开放工具作为 dynamic tool 交给模型；同名静态工具优先。
    // inputSchema 可能是 FlexibleSchema（zod / Standard Schema / 带 validate 的
    // jsonSchema），也可能只是一份纯 JSON Schema 描述：前者交给上游归一，后者按描述
    // 本身包一层；没给就是上游的空对象默认值。
    let inputSchema: FlexibleSchema<unknown>;
    try {
      inputSchema = asSchema(openTool.inputSchema as FlexibleSchema<unknown>);
    } catch {
      inputSchema = jsonSchema(openTool.inputSchema as JSONSchema7);
    }
    modelTools[openTool.name] = dynamicTool({
      description: openTool.description,
      inputSchema,
    });
  }
  const requestTools = Object.keys(modelTools).length === 0 ? undefined : modelTools;

  const originalMessages = [...options.conversation.messages];

  const sourceChunks = createUIMessageStream<ApplicationMessage<TOOLS>>({
    originalMessages,
    onError(cause) {
      fail(modelRequestFailed(cause));
      // 给客户端的是稳定事实，不是上游错误的细节。
      return "model-request-failed";
    },
    async execute({ writer }) {
      const modelMessages = await convertToModelMessages([...options.conversation.messages], {
        tools: requestTools,
      });

      const generation = streamText({
        ...options.generation,
        model: options.model,
        messages: modelMessages,
        // System UI messages are conversation facts. ai@7.0.101 requires this
        // explicit option to accept their normal ModelMessage projection.
        allowSystemInMessages: true,
        tools: requestTools as TOOLS,
        activeTools: options.activeTools === undefined ? undefined : [...options.activeTools],
        toolChoice: options.toolChoice,
        stopWhen: isStepCount(1),
        abortSignal,
        providerOptions: options.providerOptions,
        prepareStep: options.prepareStep,
        experimental_download:
          download === undefined ? undefined : (assets) => download(assets, abortSignal),
        // The pinned SDK's default prints raw provider errors. Observe failures
        // through result instead; abort remains an execution outcome we own.
        onError({ error }) {
          fail(
            abortSignal.aborted
              ? new IntelligenceError({ code: "aborted" }, { cause: error })
              : modelRequestFailed(error),
          );
        },
      });

      let mediaUsage: MediaUsage = {};
      let providerMetadata: MessageMetadata["providerMetadata"];

      writer.merge(
        toUIMessageStream<TOOLS, ApplicationMessage<TOOLS>>({
          stream: generation.stream,
          tools: requestTools as TOOLS,
          originalMessages,
          // 最后一条是 assistant 时上游按续写复用它的 id；否则这里给这条消息一个 id。
          generateMessageId: () => generateId(),
          onError(cause) {
            fail(modelRequestFailed(cause));
            return "model-request-failed";
          },
          // 这轮用了什么、为什么停、花了多少：只进消息元数据，不进模型请求。
          messageMetadata({ part }) {
            // 媒体用量在 finish-step 的 providerMetadata 上；先接住，等 finish 时和
            // token 用量一起写进最终消息。
            if (part.type === "finish-step") {
              mediaUsage = mediaUsageOf(part.providerMetadata);
              providerMetadata = part.providerMetadata;
              return undefined;
            }
            if (part.type !== "finish") return undefined;
            const usage = { ...part.totalUsage, ...mediaUsage };
            return {
              modelId: modelIdOf(options.model),
              finishReason: part.finishReason,
              ...(providerMetadata === undefined ? {} : { providerMetadata }),
              // 原样带上上游的完整 usage，但全空时不挂这个字段：没量可算和算出 0 是两回事。
              ...(hasUsage(usage) ? { usage } : {}),
            };
          },
          async onEnd({ messages, isAborted, outcome }) {
            // 流自己说了它失败：这条消息不算事实，不能当成功交出去。
            if (isAborted || outcome.status === "aborted") {
              fail(new IntelligenceError({ code: "aborted" }));
              return;
            }
            if (outcome.status === "failed") {
              fail(modelRequestFailed(outcome.error));
              return;
            }
            const message = messages.at(-1);
            if (message === undefined) {
              fail(new IntelligenceError({ code: "model-request-failed" }));
              return;
            }
            settle(await withEstimatedPrice(message, options.estimatePrice));
          },
        }) as ReadableStream<never>,
      );
    },
  });

  const chunks = sourceChunks.pipeThrough(
    new TransformStream({
      cancel(reason) {
        fail(new IntelligenceError({ code: "aborted" }, { cause: reason }));
        controller.abort(reason);
      },
    }),
  );

  return {
    chunks,
    result,
    abort() {
      controller.abort();
    },
  };
}

/**
 * 给这条消息补上估价。
 *
 * 价格可以异步（动态价要取数），所以在 onEnd 里 await：只推迟 result 什么时候 resolve，
 * chunk 流早就走完了，客户端不受影响。
 *
 * 算出来是什么就记什么，`{ errors }` 也记：算不出来是个事实，调用方有权知道。
 * 价格函数自己抛了就记一句稳定的说明——抛出来的原文可能是上游细节，不往外带——
 * 总之这一轮照常算成功。
 */
async function withEstimatedPrice<TOOLS extends ToolSet>(
  message: ApplicationMessage<TOOLS>,
  estimatePrice: AgentRequestOptions<TOOLS>["estimatePrice"],
): Promise<ApplicationMessage<TOOLS>> {
  if (estimatePrice === undefined) return message;
  const usage = message.metadata?.usage;
  if (usage === undefined) return message;

  let result: MessagePriceEstimation;
  try {
    result = await estimatePrice(usage);
  } catch {
    result = { errors: ["price function threw"] };
  }

  return {
    ...message,
    metadata: { ...message.metadata, estimatedPrice: result },
  };
}

/** usage 里有没有实际账目。空容器不算，显式的 0 算。 */
function hasUsage(usage: MessageUsage): boolean {
  const input = usage.inputTokenDetails;
  const output = usage.outputTokenDetails;
  return (
    usage.inputTokens !== undefined ||
    usage.outputTokens !== undefined ||
    usage.totalTokens !== undefined ||
    input?.noCacheTokens !== undefined ||
    input?.cacheReadTokens !== undefined ||
    input?.cacheWriteTokens !== undefined ||
    output?.textTokens !== undefined ||
    output?.reasoningTokens !== undefined ||
    hasMediaUsage(usage)
  );
}

function hasMediaUsage(usage: MediaUsage): boolean {
  return [usage.image, usage.video, usage.audio].some(
    (sides) => (sides?.input?.length ?? 0) > 0 || (sides?.output?.length ?? 0) > 0,
  );
}

/** 元数据里的模型标识：给了字符串就用它，给了模型对象就取它的 modelId。 */
function modelIdOf(model: LanguageModel): string | undefined {
  if (typeof model === "string") return model;
  const modelId = (model as { readonly modelId?: unknown }).modelId;
  return typeof modelId === "string" ? modelId : undefined;
}

/**
 * 取 core 自己那层媒体用量。
 *
 * 形状由 adapter 的包装层拥有；这里只把 image / video / audio 三支摘出来，别的键不往
 * 消息里带。数组里的每一条已经按产物的真实形状收过，core 不再重新解释它。
 */
function mediaUsageOf(providerMetadata: unknown): MediaUsage {
  if (providerMetadata === null || typeof providerMetadata !== "object") return {};
  const ours = (providerMetadata as Record<string, unknown>)[CORRECT_AI_NAMESPACE];
  if (ours === null || typeof ours !== "object") return {};
  const media = ours as Record<string, unknown>;
  return {
    ...(media["image"] === undefined ? {} : { image: media["image"] as MediaUsage["image"] }),
    ...(media["video"] === undefined ? {} : { video: media["video"] as MediaUsage["video"] }),
    ...(media["audio"] === undefined ? {} : { audio: media["audio"] as MediaUsage["audio"] }),
  };
}

/** 上游的失败原因挂 cause；对外只有稳定事实。 */
function modelRequestFailed(cause: unknown): IntelligenceError {
  return new IntelligenceError({ code: "model-request-failed" }, { cause });
}

export * as chunks from "./chunks.ts";
export * as codec from "./codec.ts";
export * as tools from "./tools.ts";
