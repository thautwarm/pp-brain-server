/**
 * 工具调用这一层：读会话里的调用状态，并按运行时工具定义解释它们。
 *
 * 一是从消息的 part 状态里找出未解决的工具调用、把结果补回去；二是把模型发起的调用
 * 按工具定义校验成 closed / open / invalid 三态。不执行工具、不管审批和副作用，也不
 * 改写调用方的会话数据；只有调用方自己用错（同一次调用里 toolCallId 重复、给不认识
 * 的结果）才抛 IntelligenceError。
 *
 * 可执行校验来自 FlexibleSchema 里真正能跑的那部分：zod、Standard Schema，以及带
 * validate 的 jsonSchema。只有 JSON Schema 描述、没有 validate 的（含直接给的 JSON
 * Schema 对象、惰性函数抛错的）没有可执行能力，一律 fail-closed 判 invalid。
 */
import {
  asSchema,
  type FlexibleSchema,
  type Schema,
  safeValidateTypes,
} from "@ai-sdk/provider-utils";
import {
  type DynamicToolUIPart,
  getToolName,
  isToolUIPart,
  type ToolSet,
  type ToolUIPart,
} from "ai";
import type {
  AgentToolCall,
  Conversation,
  PendingToolCall,
  ToolCallDiagnostic,
  ToolInputIssue,
  ToolResultInput,
  ToolSettings,
} from "../index.ts";
import { IntelligenceError } from "../index.ts";

type AnyToolPart = ToolUIPart | DynamicToolUIPart;

/** 上游 part 的状态枚举；不从我们这边手抄字符串。 */
type ToolPartState = AnyToolPart["state"];

/** 联合类型上取全部出现的 key（`keyof` 在联合上只给公共部分）。 */
type AllKeys<T> = T extends unknown ? keyof T : never;

/**
 * 每个上游状态算不算「已解决」，逐项表态。
 *
 * 用 Record<ToolPartState, boolean> 而不是 Set<string>：上游新增或改名状态时，
 * 这里会直接编译不过，逼我们重新决定，不会静默当成未解决。
 */
const RESOLVED_BY_STATE: Record<ToolPartState, boolean> = {
  "input-streaming": false,
  "input-available": false,
  "approval-requested": false,
  "approval-responded": false,
  "output-available": true,
  "output-error": true,
  "output-denied": true,
};

function isUnresolved(part: AnyToolPart): boolean {
  if (!RESOLVED_BY_STATE[part.state]) return true;
  // preliminary 只出现在 output-available 上：真值表示这还只是过程快照，没定稿。
  if (part.state === "output-available") return part.preliminary === true;
  return false;
}

export function pending(conversation: Conversation): readonly PendingToolCall[] {
  const byId = new Map<string, PendingToolCall>();
  for (const message of conversation.messages) {
    for (const part of message.parts) {
      if (!isToolUIPart(part)) continue;
      const toolCallId = part.toolCallId;
      if (isUnresolved(part)) {
        byId.set(toolCallId, {
          toolCallId,
          toolName: getToolName(part),
          input: part.input,
        });
      } else {
        byId.delete(toolCallId);
      }
    }
  }
  return [...byId.values()];
}

/**
 * 状态专属字段：这些字段哪些合法由上游的 union 决定。列在这里的每个 key 都要是上游
 * part 上真实存在的字段，上游改名或删掉时这里编译不过。
 */
const STATE_FIELDS = [
  "output",
  "errorText",
  "preliminary",
  "rawInput",
  "approval",
  "resultProviderMetadata",
] as const satisfies readonly AllKeys<AnyToolPart>[];

/** Omit 作用在联合上会丢掉判别字段，这里逐支处理，保住 type / toolName。 */
type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;

type WithoutStateFields = DistributiveOmit<AnyToolPart, (typeof STATE_FIELDS)[number]>;

/** 剥掉状态专属字段，只留跨状态都在的部分；input 虽然可选，改写后仍是同一个输入。 */
function withoutStateFields(part: AnyToolPart): WithoutStateFields {
  const copy: Record<string, unknown> = { ...part };
  for (const field of STATE_FIELDS) delete copy[field];
  return copy as WithoutStateFields;
}

function withResult(part: AnyToolPart, result: ToolResultInput): AnyToolPart {
  // input 在上游部分状态下是可选的；终态都要求带着输入，这里显式补回。
  const base = { ...withoutStateFields(part), input: part.input };
  // 落定的结果按上游 union 的两个终态构造：错误态带 errorText，正常态带 output。
  return result.isError
    ? {
        ...base,
        state: "output-error",
        errorText: String(result.output ?? ""),
      }
    : {
        ...base,
        state: "output-available",
        output: result.output,
      };
}

export function complete<TOOLS extends ToolSet>(
  conversation: Conversation<TOOLS>,
  results: readonly ToolResultInput[],
): Conversation<TOOLS> {
  if (results.length === 0) return conversation;

  const byId = new Map<string, ToolResultInput>();
  for (const result of results) {
    if (byId.has(result.toolCallId)) {
      throw new IntelligenceError({
        code: "invalid-conversation",
        field: "toolCallId",
      });
    }
    byId.set(result.toolCallId, result);
  }

  const open = new Set(pending(conversation).map((call) => call.toolCallId));
  for (const toolCallId of byId.keys()) {
    if (!open.has(toolCallId)) {
      throw new IntelligenceError({
        code: "invalid-conversation",
        field: "toolCallId",
      });
    }
  }

  const messages = conversation.messages.map((message) => ({
    ...message,
    parts: message.parts.map((part) => {
      if (!isToolUIPart(part)) return part;
      const result = byId.get(part.toolCallId);
      if (!result || !isUnresolved(part)) return part;
      return withResult(part, result);
    }),
  }));

  return { messages } as Conversation<TOOLS>;
}

export function validate(
  calls: readonly PendingToolCall[],
  settings: ToolSettings<ToolSet>,
): Promise<readonly AgentToolCall<ToolSet>[]> {
  return validateCalls(calls, settings);
}

export function validateTyped<TOOLS extends ToolSet>(
  calls: readonly PendingToolCall[],
  settings: ToolSettings<TOOLS>,
): Promise<readonly AgentToolCall<TOOLS>[]> {
  return validateCalls(calls, settings);
}

// async 在这里是承重的，不是多余：assertSettings / assertDistinctCallIds 是同步抛，
// 靠 async 把它们转成 rejected promise，调用方才能统一用 .catch / await 接。
// 去掉 async 会让这两个校验变成同步抛出，破坏上面两个导出函数的 Promise 契约。
async function validateCalls<TOOLS extends ToolSet>(
  calls: readonly PendingToolCall[],
  settings: ToolSettings<TOOLS>,
): Promise<readonly AgentToolCall<TOOLS>[]> {
  assertSettings(settings);
  assertDistinctCallIds(calls);
  return Promise.all(calls.map((call) => validateCall<TOOLS>(call, settings)));
}

function assertDistinctCallIds(calls: readonly PendingToolCall[]): void {
  const seen = new Set<string>();
  for (const call of calls) {
    if (seen.has(call.toolCallId)) {
      throw new IntelligenceError({
        code: "invalid-conversation",
        field: "toolCallId",
      });
    }
    seen.add(call.toolCallId);
  }
}

/**
 * 调用方用错（settings 形状不对）时抛 IntelligenceError，而不是让原生 TypeError
 * 从某个属性访问里漏出去。
 */
function assertSettings<TOOLS extends ToolSet>(settings: ToolSettings<TOOLS>): void {
  if (!isRecord(settings) || !isRecord(settings.tools)) {
    throw new IntelligenceError({
      code: "invalid-tool-settings",
      field: "tools",
    });
  }
  if (settings.openTools !== undefined && !Array.isArray(settings.openTools)) {
    throw new IntelligenceError({
      code: "invalid-tool-settings",
      field: "openTools",
    });
  }
}

async function validateCall<TOOLS extends ToolSet>(
  call: PendingToolCall,
  settings: ToolSettings<TOOLS>,
): Promise<AgentToolCall<TOOLS>> {
  const closed = Object.hasOwn(settings.tools, call.toolName)
    ? (settings.tools[call.toolName as keyof TOOLS & string] as {
        readonly inputSchema?: unknown;
      })
    : undefined;
  const open = settings.openTools?.find((tool) => tool.name === call.toolName);

  // 未知工具：静态定义和运行时开放工具里都没有这个名字。
  if (closed === undefined && open === undefined) {
    return invalidCall<TOOLS>(call, [
      {
        path: "",
        reason: "unknown-tool",
        message: `Unknown tool: ${call.toolName}`,
      },
    ]);
  }

  // 静态定义优先：同一个名字两边都有时，按有类型的那份解释。
  const schema = closed === undefined ? open?.inputSchema : closed.inputSchema;

  const resolved = toValidator(schema);

  // 校验器本身建不起来：这是「有 schema 但用不了」，和「压根没给 schema」分开报。
  if (resolved !== undefined && !resolved.ok) {
    return invalidCall<TOOLS>(call, [
      {
        path: "",
        reason: "validator-failed",
        message: `Input validator for tool ${call.toolName} failed to build: ${
          messageOf(resolved.cause) ?? String(resolved.cause)
        }`,
      },
    ]);
  }

  // fail-closed：没有可执行的校验能力，就不能声称这条输入合法。
  if (resolved === undefined || resolved.validator.validate == null) {
    return invalidCall<TOOLS>(call, [
      {
        path: "",
        reason: "no-validator",
        message: `No executable input validator for tool: ${call.toolName}`,
      },
    ]);
  }

  const result = await safeValidateTypes({
    value: call.input,
    schema: resolved.validator,
  });
  if (!result.success) {
    return invalidCall<TOOLS>(call, toInputIssues(result.error));
  }

  return closed === undefined
    ? {
        toolCallId: call.toolCallId,
        toolName: call.toolName,
        kind: "open",
        input: result.value,
      }
    : ({
        toolCallId: call.toolCallId,
        toolName: call.toolName,
        kind: "closed",
        input: result.value,
      } as AgentToolCall<TOOLS>);
}

function invalidCall<TOOLS extends ToolSet>(
  call: PendingToolCall,
  issues: readonly ToolInputIssue[],
): AgentToolCall<TOOLS> {
  const diagnostic: ToolCallDiagnostic = {
    toolCallId: call.toolCallId,
    toolName: call.toolName,
    issues,
  };
  return {
    toolCallId: call.toolCallId,
    toolName: call.toolName,
    kind: "invalid",
    input: call.input,
    diagnostic,
  };
}

type ValidatorResolution =
  | { readonly ok: true; readonly validator: Schema<unknown> }
  | { readonly ok: false; readonly cause: unknown };

/**
 * 惰性 schema 的构造函数可能抛错。以前这里 catch 完就返回 undefined，真因直接消失，
 * 诊断还会说成「没有可执行校验器」。现在把失败原因带出来，由调用处分类。
 */
function toValidator(schema: unknown): ValidatorResolution | undefined {
  if (schema === undefined || schema === null) return undefined;
  try {
    return { ok: true, validator: asSchema(schema as FlexibleSchema<unknown>) };
  } catch (cause) {
    return { ok: false, cause };
  }
}

function toInputIssues(error: unknown): readonly ToolInputIssue[] {
  const seen = new Set<unknown>();
  let current: unknown = error;
  let message = "";
  // 只顺 cause 找几层：上游把原始错误包过一层（TypeValidationError）。
  for (
    let depth = 0;
    depth < 4 && current !== undefined && current !== null && !seen.has(current);
    depth += 1
  ) {
    seen.add(current);
    const issues = readIssues(current);
    if (issues.length > 0) return issues;
    message = messageOf(current) ?? message;
    current = (current as { cause?: unknown }).cause;
  }
  return [
    {
      path: "",
      reason: "invalid-input",
      message: message.length > 0 ? message : "Invalid tool input",
    },
  ];
}

function readIssues(error: unknown): readonly ToolInputIssue[] {
  const list = Array.isArray(error)
    ? error
    : isRecord(error) && Array.isArray(error.issues)
      ? error.issues
      : undefined;
  if (list === undefined) return [];

  const issues: ToolInputIssue[] = [];
  for (const raw of list) {
    if (!isRecord(raw)) continue;
    const message = raw.message;
    if (typeof message !== "string" || message.length === 0) continue;
    issues.push({
      path: formatPath(raw.path),
      message,
      reason: "invalid-input",
    });
  }
  return issues;
}

function formatPath(path: unknown): string {
  if (!Array.isArray(path)) return typeof path === "string" ? path : "";
  return path.map((segment) => segmentText(segment)).join(".");
}

function segmentText(segment: unknown): string {
  if (typeof segment === "string" || typeof segment === "number") {
    return String(segment);
  }
  return typeof segment === "symbol" ? (segment.description ?? "") : "";
}

function messageOf(error: unknown): string | undefined {
  return error instanceof Error && error.message.length > 0 ? error.message : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
