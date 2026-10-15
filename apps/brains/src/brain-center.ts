import type { BrainPorts } from "./http.ts";
import { AudioHelper } from '@might/audio';
import type { ApplicationMessage } from '@might/chat';
import { callTranscript, callVoiceGen } from "./stt-tts.ts";
import { Format, SizedQueueOps } from "./format.ts";
import { reviseText, maybeCompression } from './revise.ts'

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
        const brainId = req.brain_id;
        const brain = brainsStore.get(brainId);
        if (!brain) {
            throw new Error(`Brain with ID ${brainId} not found`);
        }
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
        const brain = brainsStore.get(req.brain_id);
        if (!brain) {
            throw new Error(`Brain with ID ${req.brain_id} not found`);
        }
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

    async agentToBrain(req, { signal }) {
        const brainId = req.brain_id;
        const brain = brainsStore.get(brainId);
        if (!brain) {
            throw new Error(`Brain with ID ${brainId} not found`);
        }
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
        const brainId = req.brain_id;
        const brain = brainsStore.get(brainId);
        if (!brain) {
            throw new Error(`Brain with ID ${brainId} not found`);
        }

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