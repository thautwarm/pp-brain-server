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
    for (const [_, brain] of brainsStore) {
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

                    SizedQueueOps.push(
                        brain.outbounds.agent,
                        { text: warning },
                        64,
                    )
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
                    const ttsResult = await callVoiceGen(it.text, brain.voice, { signal: undefined })
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

        SizedQueueOps.push(
            brain.outbounds.agent,
            { text: Format.asrToAgentReply(result.text) },
            64,
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

        let agentText = brain.outbounds.agent.shift();
        if (agentText !== undefined) {
            return { kind: 'text', text: agentText.text };
        }

        while (brain.outbounds.agent.length === 0) {
            if (signal.aborted) {
                return { kind: 'empty' }
            }
            await new Promise(resolve => setTimeout(resolve, 50));
        }
        agentText = brain.outbounds.agent.shift();
        if (agentText === undefined) {
            return { kind: 'empty' }
        }

        return { kind: 'text', text: agentText.text };
    }
}