import { ChatAgent, deepseek } from '@might/chat'
import type { MessagePart, ApplicationMessage, ToolResultInput } from '@might/chat'

import type { Brain } from './brain-center.ts';
import { Format } from './format.ts';
import { tool } from 'ai';
import type { ToolSet } from 'ai';
import { z } from 'zod'

function toChatContext(brain: Brain) {
    let userMessage: MessagePart[] = []
    let result: ApplicationMessage[] = []
    const flushUser = () => {
        if (userMessage.length == 0) {
            return false;
        }
        result.push({
            role: 'user',
            parts: userMessage,
            id: result.length.toString()
        });
        userMessage = []
        return true;
    }

    if (brain.historySummary !== undefined) {
        userMessage.push({
            type: 'text',
            text: brain.historySummary
        });
    }

    for (const item of brain.history) {
        if (item.kind === 'assistant-message') {
            flushUser();
            result.push(item.message);
        }
        if (item.kind == 'human-message') {
            flushUser();
            result.push({ ...item.message, id: result.length.toString() });
        }
        if (item.kind === 'human-audio') {
            userMessage.push({
                type: 'file',
                url: "data:audio/ogg;base64," + item.audioB64,
                mediaType: 'audio/ogg'
            });
        }
        if (item.kind === 'human-audio-transcript') {
            userMessage.push({
                type: 'text',
                text: Format.asrToAgentReply(item.text)
            });
        }
        if (item.kind === 'agent-text') {
            userMessage.push({
                type: 'text',
                text: Format.claimAgentResponse(item.text)
            });
        }

    }
    const lastIsUser = flushUser();
    return { lastIsUser, chatContext: result };
}


const mkModel = () => deepseek.prepare({
    // 端点（baseURL + key）和模型名都是部署的事。默认挑 flash：这是后台校对，不值得用 pro。
    model: process.env.MIGHT_CHAT_MODEL ?? "mimo-v2.6-flash",
    args: { level: 'high' },
    credential: { auth: { apiKey: process.env.MIGHT_CHAT_API_KEY ?? "" }, baseURL: process.env.MIGHT_CHAT_API_BASE_URL ?? "" },
})

const modelRef: { current: ReturnType<typeof mkModel> | null } = { current: null };

const toolset: ToolSet = {
    notify: tool({
        inputSchema: z.object({
            warning: z.string()
        }),
        description: 'Notify the agent with a warning when the in-context audio transcription might be misleading',
    })
}

export async function reviseText(brain: Brain): Promise<{ evaluatedMaxTokens: number, warning: string }> {
    const { chatContext } = toChatContext(brain);
    modelRef.current ??= mkModel();
    const { generation, providerOptions, languageModel } = modelRef.current;

    const userPrompt: ApplicationMessage = {
        role: 'user',
        id: 's_user' + chatContext.length.toString(),
        parts: [
            {
                type: 'text',
                text:
                    Format.systemNotification("请检查最近的语音转录是否准确，如果你认为<asr-recognized-text>的内容可能对agent造成了误导，可使用工具 notify(warning) 来提醒 agent")

            }
        ]
    }

    let conv = ChatAgent.append({ messages: chatContext }, userPrompt)

    const req = ChatAgent.request({
        model: languageModel,
        tools: { notify: toolset.notify as any },
        conversation: conv,
        generation: generation,
        providerOptions: { "deepseek": providerOptions },
        abortSignal: AbortSignal.timeout(50000),
    })

    const response = await req.result
    const evaluatedMaxTokens = response.metadata?.usage?.totalTokens ?? JSON.stringify(conv).length / 4;

    conv = ChatAgent.append(conv, response);
    const replies: ToolResultInput[] = [];
    let warnings: string[] = [];
    for (const it of ChatAgent.tools.pending(conv)) {
        if (it.toolName == 'notify') {
            const warning = ((it.input ?? { warning: "" }) as { warning?: string }).warning;
            if (typeof warning === 'string') {
                warnings.push(warning)
                replies.push(
                    {
                        toolCallId: it.toolCallId,
                        output: "Notification done:" + warning
                    }
                )
            }
            else {
                replies.push(
                    {
                        toolCallId: it.toolCallId,
                        output: "Notification failed: missing warning (" + JSON.stringify(it.input) + ")"
                    }
                )
            }
        }
        else {
            replies.push(
                {
                    toolCallId: it.toolCallId,
                    output: "Unknown tool: " + it.toolName
                }
            )
        }
    }

    conv = ChatAgent.tools.complete(conv, replies);

    if (conv.messages[conv.messages.length - 1]!.role === 'assistant') {
        brain.history.push({
            kind: 'human-message',
            message: userPrompt as any
        });
        brain.history.push({
            kind: 'assistant-message',
            message: conv.messages[conv.messages.length - 1]! as any
        });
    }

    if (warnings.length > 0) {
        return { evaluatedMaxTokens, warning: Format.warning(warnings.join("; ")) }
    }

    return { evaluatedMaxTokens, warning: "" }
}

export async function maybeCompression(brain: Brain, currentTokens: number, maxCompressionTokens: number): Promise<void> {
    const history = brain.history;
    if (currentTokens < maxCompressionTokens) {
        return
    }

    const { chatContext } = toChatContext(brain);

    const userPrompt: ApplicationMessage = {
        role: 'user',
        id: 's_user' + chatContext.length.toString(),
        parts: [
            {
                type: 'text',
                text: "现在历史记录已经很长，请为历史创建一段总结性的摘要"
            }
        ]
    }

    const conv = ChatAgent.append({ messages: chatContext }, userPrompt);
    modelRef.current ??= mkModel();
    const { generation, providerOptions, languageModel } = modelRef.current;

    const response = ChatAgent.request(
        {
            conversation: conv,
            model: languageModel,
            generation,
            providerOptions: {
                deepseek: providerOptions,
            },
            abortSignal: AbortSignal.timeout(120000),
        }
    )

    const summary = (await response.result).parts.map(part => {
        if (part.type === 'text') {
            return part.text
        }
        return ""
    }).join("")
    brain.historySummary = summary || "<no summary>";

    if (history.length > 12) {
        history.splice(0, history.length - 12)
    }
    return
}