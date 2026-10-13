import { safeValidateUIMessages } from "ai";
import type { ApplicationMessage, Conversation } from "../index.ts";
import { IntelligenceError } from "../index.ts";

/** 当前序列化信封版本。 */
export const version = 1 as const;

/**
 * 会话 → 带版本号的 JSON 信封。
 *
 * 值域策略是「调用方保证可 JSON 序列化」；真序列化不了（循环引用、BigInt 之类）
 * 时包成 IntelligenceError，底层原因挂在 cause 上，不裸抛原生 TypeError。
 */
export function serialize(conversation: Conversation): string {
  try {
    return JSON.stringify({ version, messages: conversation.messages });
  } catch (cause) {
    throw new IntelligenceError({ code: "unserializable-conversation" }, { cause });
  }
}

/**
 * 带版本号的 JSON 信封 → 会话。
 *
 * JSON 无效、版本不匹配或消息过不了上游的 UI Message schema 时抛出。
 * 校验的边界就是结构本身：元数据、data part、工具入出参不额外传 schema，
 * 按「只保证 JSON 可序列化」的口径放过。
 *
 * 为什么是异步：校验只有上游这一个入口，而它整条链路都是异步的。
 * safeValidateUIMessages → safeValidateTypes 本身是 async function，
 * 上面的 Schema 契约又把 validate 写成 `ValidationResult | PromiseLike<...>`，
 * zod 那条分支也刻意用 safeParseAsync 而不是 safeParse（schema 里允许出现异步
 * refine / transform）。所以这里没有同步可用的校验，异步是接口给的，不是我们选的。
 *
 * serialize 不需要校验，保持同步。
 */
export async function deserialize(serialized: string): Promise<Conversation> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(serialized);
  } catch (cause) {
    throw new IntelligenceError({ code: "invalid-serialized-conversation" }, { cause });
  }

  if (!isRecord(parsed)) {
    throw new IntelligenceError({ code: "invalid-serialized-conversation" });
  }
  if (parsed.version !== version) {
    throw new IntelligenceError({
      code: "invalid-serialized-conversation",
      field: "version",
    });
  }
  if (!Array.isArray(parsed.messages)) {
    throw new IntelligenceError({
      code: "invalid-serialized-conversation",
      field: "messages",
    });
  }

  // 空会话是我们自己的合法数据，上游 schema 要求 messages 非空，这里先放行。
  if (parsed.messages.length === 0) return { messages: [] };

  const validated = await safeValidateUIMessages<ApplicationMessage>({
    messages: parsed.messages,
  });
  if (!validated.success) {
    throw new IntelligenceError(
      { code: "invalid-serialized-conversation", field: "messages" },
      { cause: validated.error },
    );
  }

  return { messages: validated.data };
}

/** JSON 顶层不一定是对象，先收口再看字段。 */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
