import type { ApplicationMessage, MessagePart, ToolResultInput } from "@might/chat";
import { ChatAgent, deepseek } from "@might/chat";
import type { ToolSet } from "ai";
import { tool } from "ai";
import { z } from "zod";
import type { Brain } from "./brain-center.ts";
import { Format } from "./format.ts";

/** 修订上下文里最多带几条音频（从尾部数）。 */
const MAX_REVISE_AUDIO = 7;

/**
 * 修订上下文里该带哪几条音频：**从尾部数最多 max 条**。
 *
 * 为什么不全带：每条音频 base64 之后就是几十 KB 量级（7 条 200KB+），而修订每 3 次写入就跑一轮。
 * prompt 问的本来就是"最近的转录准不准"，所以看尾部就够 —— 更早的那些仍然以转录文字留在上下文里。
 */
export function audioTailIndices(history: Brain["history"], max: number): Set<number> {
  const indices = history.flatMap((item, index) => (item.kind === "human-audio" ? [index] : []));
  // 注意别写成 slice(-max)：max 是 0 时 `-0 === 0`，会变成"全带"。
  return new Set(indices.slice(Math.max(0, indices.length - max)));
}

function toChatContext(brain: Brain) {
  let userMessage: MessagePart[] = [];
  const result: ApplicationMessage[] = [];
  const flushUser = () => {
    if (userMessage.length == 0) {
      return false;
    }
    result.push({
      role: "user",
      parts: userMessage,
      id: result.length.toString(),
    });
    userMessage = [];
    return true;
  };

  if (brain.historySummary !== undefined) {
    userMessage.push({
      type: "text",
      text: brain.historySummary,
    });
  }

  // 音频只带尾部最多 7 条（见 audioTailIndices）。更早的仍然以转录文字留在上下文里。
  const withAudio = audioTailIndices(brain.history, MAX_REVISE_AUDIO);

  for (const [index, item] of brain.history.entries()) {
    if (item.kind === "assistant-message") {
      flushUser();
      result.push(item.message);
    }
    if (item.kind == "human-message") {
      flushUser();
      result.push({ ...item.message, id: result.length.toString() });
    }
    if (item.kind === "human-audio") {
      if (withAudio.has(index)) {
        userMessage.push({
          type: "file",
          url: "data:audio/ogg;base64," + item.audioB64,
          mediaType: "audio/ogg",
        });
      }
    }
    if (item.kind === "human-audio-transcript") {
      userMessage.push({
        type: "text",
        text: Format.asrToAgentReply(item.text),
      });
    }
    if (item.kind === "agent-text") {
      userMessage.push({
        type: "text",
        text: Format.claimAgentResponse(item.text),
      });
    }
  }
  const lastIsUser = flushUser();
  return { lastIsUser, chatContext: result };
}

const mkModel = () =>
  deepseek.prepare({
    // 端点（baseURL + key）和模型名都是部署的事。默认挑 flash：这是后台校对，不值得用 pro。
    model: process.env.MIGHT_CHAT_MODEL ?? "mimo-v2.6-flash",
    args: { level: "high" },
    credential: {
      auth: { apiKey: process.env.MIGHT_CHAT_API_KEY ?? "" },
      baseURL: process.env.MIGHT_CHAT_API_BASE_URL ?? "",
    },
  });

const modelRef: { current: ReturnType<typeof mkModel> | null } = { current: null };
const toolset: ToolSet = {
  notify: tool({
    inputSchema: z.object({
      warning: z.string(),
    }),
    description:
      "Notify the agent with a warning when the in-context audio transcription might be misleading",
  }),
};

export async function reviseText(
  brain: Brain,
): Promise<{ evaluatedMaxTokens: number; warning: string }> {
  const { chatContext } = toChatContext(brain);
  modelRef.current ??= mkModel();
  const { generation, providerOptions, languageModel } = modelRef.current;

  const userPrompt: ApplicationMessage = {
    role: "user",
    id: "s_user" + chatContext.length.toString(),
    parts: [
      {
        type: "text",
        text: Format.systemNotification(
          "请检查最近的语音转录是否准确，如果你认为<asr-recognized-text>的内容可能对agent造成了误导，可使用工具 notify(warning) 来提醒 agent",
        ),
      },
    ],
  };

  let conv = ChatAgent.append({ messages: chatContext }, userPrompt);

  const req = ChatAgent.request({
    model: languageModel,
    tools: { notify: toolset.notify as any },
    conversation: conv,
    generation: generation,
    providerOptions: { deepseek: providerOptions },
    abortSignal: AbortSignal.timeout(50000),
  });

  const response = await req.result;
  const evaluatedMaxTokens =
    response.metadata?.usage?.totalTokens ?? JSON.stringify(conv).length / 4;

  conv = ChatAgent.append(conv, response);
  const replies: ToolResultInput[] = [];
  const warnings: string[] = [];
  for (const it of ChatAgent.tools.pending(conv)) {
    if (it.toolName == "notify") {
      const warning = ((it.input ?? { warning: "" }) as { warning?: string }).warning;
      if (typeof warning === "string") {
        warnings.push(warning);
        replies.push({
          toolCallId: it.toolCallId,
          output: "Notification done:" + warning,
        });
      } else {
        replies.push({
          toolCallId: it.toolCallId,
          output: "Notification failed: missing warning (" + JSON.stringify(it.input) + ")",
        });
      }
    } else {
      replies.push({
        toolCallId: it.toolCallId,
        output: "Unknown tool: " + it.toolName,
      });
    }
  }

  conv = ChatAgent.tools.complete(conv, replies);

  if (conv.messages[conv.messages.length - 1]!.role === "assistant") {
    brain.history.push({
      kind: "human-message",
      message: userPrompt as any,
    });
    brain.history.push({
      kind: "assistant-message",
      message: conv.messages[conv.messages.length - 1]! as any,
    });
  }

  if (warnings.length > 0) {
    return { evaluatedMaxTokens, warning: Format.warning(warnings.join("; ")) };
  }

  return { evaluatedMaxTokens, warning: "" };
}

export async function maybeCompression(
  brain: Brain,
  currentTokens: number,
  maxCompressionTokens: number,
): Promise<void> {
  const history = brain.history;
  if (currentTokens < maxCompressionTokens) {
    return;
  }

  const { chatContext } = toChatContext(brain);

  const userPrompt: ApplicationMessage = {
    role: "user",
    id: "s_user" + chatContext.length.toString(),
    parts: [
      {
        type: "text",
        text: "现在历史记录已经很长，请为历史创建一段总结性的摘要",
      },
    ],
  };

  const conv = ChatAgent.append({ messages: chatContext }, userPrompt);
  modelRef.current ??= mkModel();
  const { generation, providerOptions, languageModel } = modelRef.current;

  const response = ChatAgent.request({
    conversation: conv,
    model: languageModel,
    generation,
    providerOptions: {
      deepseek: providerOptions,
    },
    abortSignal: AbortSignal.timeout(120000),
  });

  const summary = (await response.result).parts
    .map((part) => {
      if (part.type === "text") {
        return part.text;
      }
      return "";
    })
    .join("");
  brain.historySummary = summary || "<no summary>";

  if (history.length > 12) {
    history.splice(0, history.length - 12);
  }
  return;
}
