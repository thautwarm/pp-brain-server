/**
 * @might/chat-core 的公开面。
 *
 * 会话事实只有一层：UIMessage（应用侧表示）。AI SDK 面向 provider 的 ModelMessage
 * 不作为会话存储或模块间的事实；它只在真正发请求那一刻被投影出来，用完即弃。
 * prepareStep 使用 SDK 的发送时扩展点，允许调用方给本轮投影添加请求选项。
 *
 * 公开面只放形状和类型，实现放在 implementation/ 目录，形状和这一层的命名空间对齐。
 */

import type { ProviderOptions } from "@ai-sdk/provider-utils";
import type {
  ActiveTools,
  AsyncIterableStream,
  Experimental_DownloadFunction,
  InferToolInput,
  InferUITools,
  LanguageModel,
  LanguageModelCallOptions,
  LanguageModelUsage,
  PrepareStepFunction,
  ProviderMetadata,
  ToolChoice,
  ToolSet,
  UIDataTypes,
  UIMessage,
  UIMessageChunk,
  UIMessagePart,
  UITools,
} from "ai";

import * as implementation from "./implementation/index.ts";

/**
 * 我们写在 AI SDK providerOptions / providerMetadata 上的命名空间。
 *
 * adapter 的媒体包装层和 core 读取媒体用量共用这一个源头，避免两侧各写一份字符串。
 *
 * 字符串值不要动：它是线上协议键，写入方在别的包里。改值不会报错，只会静默读不到。
 */
export const MIGHT_NAMESPACE = "MIGHT_FRAMEWORK";

// 上游公开类型
// 消费方只装本包也能拿到这些类型，不必自己再装 AI SDK。名字保持上游原名。

export type MessagePart = UIMessagePart<UIDataTypes, UITools>;
export type { ProviderOptions } from "@ai-sdk/provider-utils";
export type {
  ActiveTools,
  AsyncIterableStream,
  InferToolInput,
  InferUITool,
  InferUITools,
  LanguageModel,
  LanguageModelCallOptions,
  LanguageModelUsage,
  Tool,
  ToolChoice,
  ToolSet,
  UIDataTypes,
  UIMessage,
  UIMessageChunk,
  UIMessagePart,
  UITool,
  UITools,
} from "ai";

// 错误

/**
 * 稳定事实，不带原始输入、凭据、header 或上游 cause。
 *
 * 底层的真实异常不放这里，走 Error 标准的 cause 通道：本类型保持可序列化、可对外，
 * cause 只用来排查。以前只有前者，底层异常一被包进错误码就没了。
 */
export type IntelligenceErrorData =
  | { readonly code: "not-implemented"; readonly operation?: string }
  | { readonly code: "invalid-conversation"; readonly field?: string }
  | { readonly code: "invalid-serialized-conversation"; readonly field?: string }
  | { readonly code: "invalid-chunk-stream"; readonly field?: string }
  | { readonly code: "unserializable-conversation"; readonly field?: string }
  | { readonly code: "invalid-tool-settings"; readonly field?: string }
  | { readonly code: "invalid-tool-input"; readonly toolName?: string }
  | { readonly code: "unknown-tool"; readonly toolName?: string }
  | { readonly code: "model-request-failed" }
  | { readonly code: "aborted" };

export type IntelligenceErrorCode = IntelligenceErrorData["code"];

/**
 * 本包唯一的异常类型。
 *
 * `data` 是稳定事实，可以对外；`cause` 只用于排查，可能包着原始输入甚至凭据，
 * 别序列化它，也别直接回给终端用户。
 */
export class IntelligenceError extends Error {
  override readonly name = "IntelligenceError";
  readonly data: IntelligenceErrorData;

  constructor(data: IntelligenceErrorData, options?: { readonly cause?: unknown }) {
    super(
      "operation" in data && data.operation !== undefined
        ? `${data.code}: ${data.operation}`
        : data.code,
      options,
    );
    this.data = data;
  }

  get code(): IntelligenceErrorCode {
    return this.data.code;
  }
  get field(): string | undefined {
    return "field" in this.data ? this.data.field : undefined;
  }
  get toolName(): string | undefined {
    return "toolName" in this.data ? this.data.toolName : undefined;
  }
}

// 消息与会话

/**
 * 价格估计的结果：要么一个数，要么算不出来的原因。
 *
 * 形状跟 adapter 的 PriceResult 一致。core 不认卡片，只认这条通道，所以两边各写一遍；
 * 结构对得上就接得住，哪边都不必为对方多装一个包。
 */
export type MessagePriceEstimation =
  | { readonly price: number }
  | { readonly errors: readonly string[] };

export interface MediaSides<USAGE> {
  readonly input?: readonly USAGE[];
  readonly output?: readonly USAGE[];
}

export interface ImageUsage {
  readonly size?: string;
}

export interface VideoUsage {
  readonly seconds?: number;
  readonly resolution?: string;
}

export interface AudioUsage {
  readonly seconds?: number;
}

export interface MediaUsage {
  readonly image?: MediaSides<ImageUsage>;
  readonly video?: MediaSides<VideoUsage>;
  readonly audio?: MediaSides<AudioUsage>;
}

/** 一轮的完整账：AI SDK 的 token usage，加上我们记的媒体用量。 */
export type MessageUsage = LanguageModelUsage & MediaUsage;

/**
 * 应用侧拿得到、也进存储的元数据：这轮用了什么、为什么停、花了多少。
 *
 * usage 以 AI SDK 的 LanguageModelUsage 为底：输入输出、缓存读写、推理 token、总量、
 * provider 原始值都在里面。图片、视频、音频的用量挂在同一对象的 image / video / audio 下。
 */
export interface MessageMetadata {
  readonly modelId?: string;
  readonly finishReason?: string;
  /** SDK 最后一个 step 的原生响应元数据；进入消息事实，不进入请求参数。 */
  readonly providerMetadata?: ProviderMetadata;
  readonly usage?: MessageUsage;
  /**
   * 这一轮的估价，由传进来的价格函数算。
   *
   * 整个结果都放这儿，`{ errors }` 也放——算不出来是个事实，调用方有权知道，
   * 不该只剩一个空字段。没传价格函数时才是真的没有这个字段。
   */
  readonly estimatedPrice?: MessagePriceEstimation;
}

/**
 * 会话事实就是 UIMessage，不另造一套平行类型。
 *
 * TOOLS 就是调用方的工具定义（带 inputSchema 的 ToolSet）：给了它，message.parts
 * 会按 `tool-<名字>` 判别，每个工具的 input 都由 schema 推出类型；不给就全是 unknown。
 * UI 侧的工具表是内部派生的，不需要调用方自己写。
 */
export type ApplicationMessage<TOOLS extends ToolSet = ToolSet> = UIMessage<
  MessageMetadata,
  UIDataTypes,
  ToolMap<TOOLS>
>;

/** 一段会话的全部事实。 */
export interface Conversation<TOOLS extends ToolSet = ToolSet> {
  readonly messages: readonly ApplicationMessage<TOOLS>[];
}

/** 模型发起、应用还没给结果的工具调用。无类型：会话是数据。 */
export interface PendingToolCall {
  readonly toolCallId: string;
  readonly toolName: string;
  readonly input: unknown;
}

/** 应用给出的工具结果，用于补上未解决的调用。 */
export interface ToolResultInput {
  readonly toolCallId: string;
  readonly output: unknown;
  readonly isError?: boolean;
}

// 工具定义与调用

/** 运行时的工具定义：模型拿到的就是它。 */
export type ToolDefinitions = ToolSet;

/** 从工具定义推出 UI 侧的工具表；公开面的 TOOLS 收 ToolSet，内部用它转一次。 */
export type ToolMap<TOOLS extends ToolSet> = InferUITools<TOOLS>;

/** 运行时开放工具：模型能看到，但没有静态定义，input 只能是 unknown。 */
export interface OpenToolDefinition {
  /** 请求中保留 __…__ 形式的名字，不允许用作工具名。 */
  readonly name: string;
  readonly description?: string;
  readonly inputSchema?: unknown;
}

/** 校验要的定义：静态工具表（可带类型）+ 可选的运行时开放工具。 */
export interface ToolSettings<TOOLS extends ToolSet = ToolSet> {
  readonly tools: TOOLS;
  readonly openTools?: readonly OpenToolDefinition[];
}

/** 问题出自哪一步：调用本身、有没有校验能力、校验器能不能建起来、还是校验没过。 */
export type ToolInputIssueReason =
  | "unknown-tool"
  | "no-validator"
  | "validator-failed"
  | "invalid-input";

export interface ToolInputIssue {
  readonly path: string;
  readonly message: string;
  /** 稳定分类；message 给人看，reason 给代码判。 */
  readonly reason: ToolInputIssueReason;
}

/** 对一次工具调用的解释结果。模型给的原始参数留在会话里，这里不改写它。 */
export interface ToolCallDiagnostic {
  readonly toolCallId: string;
  readonly toolName: string;
  readonly issues: readonly ToolInputIssue[];
}

interface ToolCallBase {
  readonly toolCallId: string;
  readonly toolName: string;
}

/** 校验通过的调用：按 tool 名判别，input 跟着工具定义带类型。 */
export type ClosedToolCall<TOOLS extends ToolSet = ToolSet> = {
  [NAME in keyof TOOLS & string]: ToolCallBase & {
    readonly kind: "closed";
    readonly toolName: NAME;
    readonly input: InferToolInput<TOOLS[NAME]>;
  };
}[keyof TOOLS & string];

/** 未知工具或输入不合法：诊断跟着这条调用走，不会被丢掉。 */
export interface InvalidToolCall extends ToolCallBase {
  readonly kind: "invalid";
  readonly input: unknown;
  readonly diagnostic: ToolCallDiagnostic;
}

/** 开放工具走通了校验：没有静态定义，input 保持 unknown。 */
export interface OpenToolCall extends ToolCallBase {
  readonly kind: "open";
  readonly input: unknown;
}

export type AgentToolCall<TOOLS extends ToolSet = ToolSet> =
  | ClosedToolCall<TOOLS>
  | OpenToolCall
  | InvalidToolCall;

// 一次请求的类型

export interface AgentRequestOptions<TOOLS extends ToolSet = ToolSet> {
  readonly conversation: Conversation<TOOLS>;
  readonly model: LanguageModel;
  /** 工具名不可同时以 __ 开头和结尾；该形式由框架保留。 */
  readonly tools?: TOOLS;
  /** 本轮可调用的工具；其他工具定义仍供历史结果转换使用。缺省启用全部。 */
  readonly activeTools?: Readonly<NonNullable<ActiveTools<TOOLS>>>;
  /** 本轮的工具选择，独立于 generation 与厂商参数。 */
  readonly toolChoice?: ToolChoice<TOOLS>;
  /** 运行时开放工具：模型能看到，但没有静态定义。 */
  readonly openTools?: readonly OpenToolDefinition[];
  /** adapter 编译出来的调用参数，原样交给 AI SDK。 */
  readonly generation?: LanguageModelCallOptions;
  readonly providerOptions?: ProviderOptions;
  /** SDK 发送时扩展点；处理临时投影，不改变 UIMessage 会话事实。 */
  readonly prepareStep?: PrepareStepFunction<TOOLS>;
  /** SDK 的附件下载扩展点；第二个参数是本轮合并后的取消信号。 */
  readonly download?: (
    assets: Parameters<Experimental_DownloadFunction>[0],
    abortSignal: AbortSignal,
  ) => ReturnType<Experimental_DownloadFunction>;
  /**
   * 这一轮的价格：拿到 usage 之后算一次，写进结果消息的元数据。
   *
   * 可以异步——动态价要取数。算不出来（返回 errors，或者抛了）就不写 estimatedPrice 字段，
   * 这一轮照常成立。只管 result 那条消息；chunk 流上不带价格，客户端手里有 usage，
   * 要价格自己算。
   */
  readonly estimatePrice?: (
    usage: MessageUsage,
  ) => MessagePriceEstimation | Promise<MessagePriceEstimation>;
  readonly abortSignal?: AbortSignal;
}

export interface AgentRun<TOOLS extends ToolSet = ToolSet> {
  /**
   * 传输面：chunk 流。直接喂给 SSE / HTTP 响应，本库不解释它的内容，
   * 也不在这上面叠自己的进度事件。
   */
  readonly chunks: AsyncIterableStream<UIMessageChunk>;
  /** 这一轮的事实：一条 assistant 消息。pending 调用与诊断从它派生。 */
  readonly result: Promise<ApplicationMessage<TOOLS>>;
  abort(): void;
}

// 入口

/**
 * ChatAgent：这一层的全部入口，一个命名空间，不是一个能被创建的对象。
 *
 * 只认 model / generation / providerOptions，不掺上层的业务概念。
 *
 * 像 OCaml / F# 的模块：底下全是无状态的函数，没有实例、没有配置、没有隐藏状态。
 * 一轮 = 一次 request，一次 request 只推进一步、只产出一条 assistant 消息；
 * 要不要继续，由应用自己决定（拿回消息、补工具结果、再 request 一次）。
 */
export const ChatAgent = {
  /** 追加一条事实：用户消息，或一轮助手消息。 */
  append<TOOLS extends ToolSet>(
    conversation: Conversation<TOOLS>,
    message: ApplicationMessage<TOOLS>,
  ): Conversation<TOOLS> {
    return implementation.append(conversation, message);
  },

  /**
   * 推进一轮模型请求。不循环、不调度下一轮。
   *
   * 只推进一步：工具不执行，模型发起的调用会以未解决状态留在结果消息里，
   * 由调用方补结果、再 request 一次。
   */
  request<TOOLS extends ToolSet = ToolSet>(options: AgentRequestOptions<TOOLS>): AgentRun<TOOLS> {
    return implementation.request(options);
  },

  /**
   * 工具调用那一层：从会话里找出未解决的调用、补上结果、按工具定义解释它们。
   * 不执行工具，也不管审批和副作用。
   */
  tools: {
    /** 未解决的工具调用；同一 toolCallId 重复出现时取最近一次未解决的位置。 */
    pending(conversation: Conversation): readonly PendingToolCall[] {
      return implementation.tools.pending(conversation);
    },

    /** 用应用给出的结果补上未解决的调用。 */
    complete<TOOLS extends ToolSet>(
      conversation: Conversation<TOOLS>,
      results: readonly ToolResultInput[],
    ): Conversation<TOOLS> {
      return implementation.tools.complete(conversation, results);
    },

    /**
     * 无类型校验：按运行时工具定义解释调用。返回里 invalid 那一支带诊断，
     * 不执行、不转换。
     */
    validate(
      calls: readonly PendingToolCall[],
      settings: ToolSettings<ToolSet>,
    ): Promise<readonly AgentToolCall<ToolSet>[]> {
      return implementation.tools.validate(calls, settings);
    },

    /**
     * 有类型校验：工具表带类型，closed 那一支按 tool 名判别、input 跟着定义走；
     * invalid 那一支照旧带诊断。两条路共用一份实现，有类型的只是把泛型收窄。
     */
    validateTyped<TOOLS extends ToolSet>(
      calls: readonly PendingToolCall[],
      settings: ToolSettings<TOOLS>,
    ): Promise<readonly AgentToolCall<TOOLS>[]> {
      return implementation.tools.validateTyped(calls, settings);
    },
  },

  /**
   * 传输面：chunk 流与网络响应之间的转换，以及 chunk 流到消息流的读取。
   * 这里不含会话事实，也不在 chunk 上叠自己的进度事件。
   */
  chunks: {
    /** 服务端：把 chunk 流编码成 SSE 响应。只编码，不解释内容。 */
    toHttpResponse(chunks: ReadableStream<UIMessageChunk>): Response {
      return implementation.chunks.toHttpResponse(chunks);
    },

    /** 客户端：把 SSE 响应还原成同一种 chunk 流。解析失败项由调用方处理。 */
    fromHttpResponse(response: Response): ReadableStream<UIMessageChunk> {
      return implementation.chunks.fromHttpResponse(response);
    },

    /**
     * 应用面：把 chunk 流读成消息流，每次拿到当前这条 UIMessage 的完整快照
     * （同一个 id 逐步长出来，不是 delta）。读不读、什么时候读，由应用决定。
     */
    readMessages<TOOLS extends ToolSet = ToolSet>(
      stream: ReadableStream<UIMessageChunk>,
    ): AsyncIterableStream<ApplicationMessage<TOOLS>> {
      return implementation.chunks.readMessages<ApplicationMessage<TOOLS>>(stream);
    },
  },

  /**
   * 编解码：会话与字符串之间的转换。格式版本也属于这一层。
   * 只管格式，不管是落库还是走别的通道。
   */
  codec: {
    /** 当前序列化格式版本；读到别的版本 fail-closed。 */
    version: implementation.codec.version,

    serialize(conversation: Conversation): string {
      return implementation.codec.serialize(conversation);
    },

    /** 读回时按上游的 UI Message schema 校验结构；不合法 fail-closed。 */
    deserialize(serialized: string): Promise<Conversation> {
      return implementation.codec.deserialize(serialized);
    },
  },
};
