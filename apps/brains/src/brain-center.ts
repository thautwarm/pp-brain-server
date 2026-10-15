import { type BrainPorts, BrainNotFoundError } from "./http.ts";
import { AudioHelper } from '@might/audio';
import type { ApplicationMessage } from '@might/chat';
import { callTranscript, callVoiceGen } from "./stt-tts.ts";
import { Format, SizedQueueOps } from "./format.ts";
import { reviseText, maybeCompression } from './revise.ts'
import type { BrainConfig } from "./config.ts";

type HistoryItem =
    | { kind: "human-audio", audioB64: string }
    | { kind: 'human-audio-transcript', text: string }
    | { kind: 'agent-text', text: string }
    | { kind: 'assistant-message', message: ApplicationMessage & { role: 'assistant' } }
    | { kind: 'human-message', message: ApplicationMessage & { role: 'user' } }

function incDrity(dirty: 0 | 1 | 2 | 3 | 'in-call'): 0 | 1 | 2 | 3 | 'in-call' {
    switch (dirty) {
        case 0:
            return 1
        case 1:
            return 2
        case 2:
            return 3
        case 3:
            return 3
        case 'in-call':
            return 'in-call'
    }
}

export interface Brain {
    voice: string
    history: HistoryItem[]
    // 避免 queue shift 时把 summary 去掉
    historySummary?: string

    dirty: 0 | 1 | 2 | 3 | 'in-call'


    inbounds: {
        agent: { text: string }[]
    }

    outbounds: {
        agent: { text: string }[]

        // agent 回复给人类的 text 和 audio
        human: { text: string, audio: Uint8Array }[]
    }
}



const brainsStore = new Map<string, Brain>();

/**
 * 把 config.toml 里列的 brain 装进 store。**启动时调一次**。
 *
 * 装完之后 map 里就是全部可用的名字——配置是唯一入口，没有"请求里冒出来一个新名字就现建"这条
 * 路。所以一个拼错的 brain_id 只会得到 404，不会凭空造出一个空 brain 把错记在服务端。
 *
 * 每个 brain 的状态是进程内存里的（`history` 里还抱着历史音频的 base64），所以重启即清零。
 */
export function registerBrains(entries: readonly BrainConfig[]): void {
    for (const { id, voice } of entries) {
        brainsStore.set(id, {
            voice,
            history: [],
            dirty: 0,
            inbounds: { agent: [] },
            outbounds: { agent: [], human: [] },
        });
    }
}

/** 取一个 brain；名字不在配置里就是 BrainNotFoundError（路由回 404）。 */
function brainOf(brainId: string): Brain {
    const brain = brainsStore.get(brainId);
    if (brain === undefined) throw new BrainNotFoundError(brainId);
    return brain;
}

/** agent 那条队列（`outbounds.agent`）的帽子。满了 `SizedQueueOps.push` 会把**最老的一条挤掉**。 */
const AGENT_QUEUE_MAX = 64;

/**
 * 往 agent 队列塞一条，并把结果记一笔。
 *
 * 这条队列是**读即消费**的（`brainToAgent` 一 shift 就走了），又没有 ack 和重投，所以"消息丢了"
 * 只有两个来源，日志得能分开看：
 *
 *   1. 撞上 64 的帽子被挤掉           → `DROPPED-OLDEST`，连被挤掉的那条一起打
 *   2. 取走之后响应没送达客户端       → 出队那一刻 `signal.aborted` 已经为真，打 `ABORTED`
 *
 * 对账就简单了：**push 的条数 = 出队条数 + 队里剩的条数**，对不上就是撞了上面某一条。
 */
function pushToAgent(brain: Brain, brainId: string, text: string, source: "asr" | "warning"): void {
    const before = brain.outbounds.agent.length;
    const oldest = before >= AGENT_QUEUE_MAX ? brain.outbounds.agent[0] : undefined;

    SizedQueueOps.push(brain.outbounds.agent, { text }, AGENT_QUEUE_MAX);

    const queue = `q=${before}→${brain.outbounds.agent.length}`;
    if (oldest === undefined) {
        console.log(`[agent] +1 ${brainId} ${source} ${queue} ${brief(text)}`);
        return;
    }
    console.warn(`[agent] +1 ${brainId} ${source} ${queue} DROPPED-OLDEST ${brief(oldest.text)} <- ${brief(text)}`);
}

/**
 * 出队并记账。
 *
 * **shift 的那一刻客户端可能已经断了**（长轮询期间断开是常事），那条就再也回不来了——
 * 这是服务端唯一看得见的"取走了却没送到"，所以单独标出来。
 */
function takeFromAgent(brain: Brain, brainId: string, signal: AbortSignal): { text: string } | undefined {
    const before = brain.outbounds.agent.length;
    const item = brain.outbounds.agent.shift();
    if (item === undefined) return undefined;

    const queue = `q=${before}→${brain.outbounds.agent.length}`;
    if (signal.aborted) {
        console.warn(`[agent] -1 ${brainId} ${queue} ABORTED(客户端已断开，这条丢了) ${brief(item.text)}`);
        return item;
    }
    console.log(`[agent] -1 ${brainId} ${queue} ${brief(item.text)}`);
    return item;
}

/** 日志里只留前 60 个字：转录可能很长，别把整段刷进日志。 */
function brief(text: string): string {
    return JSON.stringify(text.length > 60 ? `${text.slice(0, 60)}…` : text);
}



const maxParallelTTS = 10;
const backgroundTaskState = {
    tts: 0,
    started: false
}

export async function startBackgroundTask() {
    if (backgroundTaskState.started) return;
    backgroundTaskState.started = true;

    while (true) {
        await backgroundTaskStep().catch(console.error);
        await new Promise(resolve => setTimeout(resolve, 35));
    }
}

async function backgroundTaskStep() {
    for (const [brainId, brain] of brainsStore) {
        if (brain.dirty === 3) {
            brain.dirty = 'in-call';
            const job = async () => {
                try {
                    const { warning, evaluatedMaxTokens } = await reviseText(brain);
                    if (!warning) {
                        if (evaluatedMaxTokens > 10240) {
                            await maybeCompression(brain, evaluatedMaxTokens, 10240)
                        }
                        return;
                    }

                    pushToAgent(brain, brainId, warning, "warning")
                    if (evaluatedMaxTokens > 10240) {
                        await maybeCompression(brain, evaluatedMaxTokens, 10240)
                    }
                }
                finally {
                    
                    brain.dirty = 0
                }
            }
            job().catch((e) => console.error(e));
        }

        for (const it of [...brain.inbounds.agent]) {
            const inQueue = async (brain: Brain, it: Brain['inbounds']['agent'][number]) => {
                if (backgroundTaskState.tts >= maxParallelTTS) return;
                if (!brain.inbounds.agent.includes(it)) return;
                try {
                    backgroundTaskState.tts++;
                    SizedQueueOps.removeByIdentity(brain.inbounds.agent, it)

                    // 念的是 forTts 过的那份（`<!-- disable voice -->` 段不念），
                    // 推给人类的 text 还是原文 —— "不念"不等于"不显示"。
                    const spoken = Format.forTts(it.text)
                    if (spoken.trim() === "") {
                        console.warn(`[tts] ${brainId} 整段都被静音了，跳过合成 ${brief(it.text)}`)
                        return
                    }

                    const ttsResult = await callVoiceGen(spoken, brain.voice, { signal: undefined })
                    SizedQueueOps.push(brain.outbounds.human, { text: it.text, audio: ttsResult.audio }, 12)
                }
                catch (e) {
                    console.error(e)
                }
                finally {
                    SizedQueueOps.removeByIdentity(brain.inbounds.agent, it)
                    backgroundTaskState.tts--;
                    backgroundTaskState.tts = Math.max(0, backgroundTaskState.tts);
                }
            }
            inQueue(brain, it);
        }
    }
}

export const Brains: BrainPorts = {

    async humanToBrain(req, { signal }) {
        const brain = brainOf(req.brain_id);
        const result = await callTranscript(req.audio, { signal: AbortSignal.any([signal, AbortSignal.timeout(13000)]) });

        SizedQueueOps.push(
            brain.history,
            { kind: 'human-audio', audioB64: AudioHelper.toBase64(req.audio) },
            64,
        )

        SizedQueueOps.push(
            brain.history,
            { kind: 'human-audio-transcript', text: result.text },
            64,
        )

        brain.dirty = incDrity(brain.dirty)

        // 人类打断时没听到的那段，插在给 agent 的文本前面。
        // 可空（不给 / null / 空串都算没有），所以这里判的是"有没有实质内容"。
        const heard = Format.asrToAgentReply(result.text)
        const unheard = req.unheard_text ?? ""
        pushToAgent(
            brain,
            req.brain_id,
            unheard.trim() === "" ? heard : `${Format.unheardText(unheard)}\n${heard}`,
            "asr",
        )

        return { kind: 'text', text: result.text }
    },

    async brainToHuman(req, { signal }) {
        // query interval: 50ms, once inbounds.agent is not empty, reply
        const brain = brainOf(req.brain_id);
        let agentReply = brain.outbounds.human.shift();
        if (agentReply !== undefined) {
            return { kind: 'text', text: agentReply.text, audio: agentReply.audio };
        }

        while (brain.outbounds.human.length === 0) {
            if (signal.aborted) {
                return { kind: 'empty' }
            }
            await new Promise(resolve => setTimeout(resolve, 50));
        }
        agentReply = brain.outbounds.human.shift();
        if (agentReply === undefined) {
            return { kind: 'empty' }
        }

        return { kind: 'text', text: agentReply.text, audio: agentReply.audio };
    },

    async agentToBrain(req) {
        const brain = brainOf(req.brain_id);
        SizedQueueOps.push(
            brain.history,
            { kind: 'agent-text', text: req.text },
            64,
        )
        SizedQueueOps.push(
            brain.inbounds.agent,
            { text: req.text },
            64,
        )
        brain.dirty = incDrity(brain.dirty)
        return { kind: 'empty' };
    },

    async brainToAgent(req, { signal }) {
        const brain = brainOf(req.brain_id);

        const brainId = req.brain_id;
        let agentText = takeFromAgent(brain, brainId, signal);
        if (agentText !== undefined) {
            return { kind: 'text', text: agentText.text };
        }

        while (brain.outbounds.agent.length === 0) {
            if (signal.aborted) {
                return { kind: 'empty' }
            }
            await new Promise(resolve => setTimeout(resolve, 50));
        }
        agentText = takeFromAgent(brain, brainId, signal);
        if (agentText === undefined) {
            return { kind: 'empty' }
        }

        return { kind: 'text', text: agentText.text };
    }
}