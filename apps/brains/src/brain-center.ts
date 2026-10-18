import { AudioHelper } from "@might/audio";
import type { ApplicationMessage } from "@might/chat";
import { Format, SizedQueueOps } from "./format.ts";
import type { BrainPorts } from "./http.ts";
import { maybeCompression, reviseText } from "./revise.ts";
import { splitForTts } from "./split.ts";
import { callTranscript, callVoiceGen } from "./stt-tts.ts";

type HistoryItem =
  | { kind: "human-audio"; audioB64: string }
  | { kind: "human-audio-transcript"; text: string }
  | { kind: "agent-text"; text: string }
  | { kind: "assistant-message"; message: ApplicationMessage & { role: "assistant" } }
  | { kind: "human-message"; message: ApplicationMessage & { role: "user" } };

function incDrity(dirty: 0 | 1 | 2 | 3 | "in-call"): 0 | 1 | 2 | 3 | "in-call" {
  switch (dirty) {
    case 0:
      return 1;
    case 1:
      return 2;
    case 2:
      return 3;
    case 3:
      return 3;
    case "in-call":
      return "in-call";
  }
}

export interface Brain {
  history: HistoryItem[];
  // 避免 queue shift 时把 summary 去掉
  historySummary?: string;

  dirty: 0 | 1 | 2 | 3 | "in-call";

  /** 最后一次交互的时刻。任意 brain_id 都能现建，所以必须有淘汰。 */
  lastActiveAt: number;

  inbounds: {
    // 音色是 per-request 的：agent-to-brain 带的那个跟着这条消息走，入队时存进队列项；没带
    // 就等合成时用全局 `TTS_VOICE`。brain 上不存音色。
    //
    // `enqueuedAt` 是服务端的 UTC 毫秒，用来配合客户端的 `skip_before` 丢弃积压（见 brainToHuman）。
    agent: { text: string; voice?: string; enqueuedAt: number; attempts?: number }[];
  };

  outbounds: {
    agent: { text: string }[];
  };
}

/** 多久没交互就从内存卸载。brain_id 是客户端随便给的，没有淘汰等于让内存无限涨。 */
const BRAIN_IDLE_MS = 2 * 60 * 60 * 1000;

/** 上次扫全表淘汰的时刻，避免每 35 ms 都遍历一遍。 */
let lastSweepAt = 0;

const brainsStore = new Map<string, Brain>();

/**
 * 卸载空闲超过 `BRAIN_IDLE_MS` 的 brain，返回被卸载的名字。
 *
 * 抽成可注入 `now` 的纯函数是为了能测边界（正好 2 小时 / 刚过期）；调用点见
 * `backgroundTaskStep`。
 */
export function evictIdleBrains(now: number): string[] {
  const evicted: string[] = [];
  for (const [brainId, brain] of brainsStore) {
    if (now - brain.lastActiveAt <= BRAIN_IDLE_MS) continue;
    brainsStore.delete(brainId);
    evicted.push(brainId);
    console.log(`[brain] ${brief(brainId)} 空闲超过 2 小时，已卸载`);
  }
  return evicted;
}

/**
 * 取一个 brain，**没有就现建**。
 *
 * 这里不再有"白名单"：`brain_id` 由客户端手输，任何非空字符串都算一个新 brain。所以
 * 拼错一个名字不会报错，而是开出一段新对话 —— 客户端的 `brain_id` 得自己稳定住。
 *
 * 状态全在进程内存里（`history` 还抱着历史音频的 base64），重启即清零；空闲超过
 * `BRAIN_IDLE_MS` 会被后台循环卸载（见 `backgroundTaskStep`）。
 */
function brainOf(brainId: string): Brain {
  let brain = brainsStore.get(brainId);
  if (brain === undefined) {
    brain = {
      history: [],
      dirty: 0,
      lastActiveAt: Date.now(),
      inbounds: { agent: [] },
      outbounds: { agent: [] },
    };
    brainsStore.set(brainId, brain);
    console.log(`[brain] ${brief(brainId)} 第一次出现，已创建`);
  }
  brain.lastActiveAt = Date.now();
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
    console.log(`[agent] +1 ${brief(brainId)} ${source} ${queue} ${brief(text)}`);
    return;
  }
  console.warn(
    `[agent] +1 ${brief(brainId)} ${source} ${queue} DROPPED-OLDEST ${brief(oldest.text)} <- ${brief(text)}`,
  );
}

/**
 * 出队并记账。
 *
 * **shift 的那一刻客户端可能已经断了**（长轮询期间断开是常事），那条就再也回不来了——
 * 这是服务端唯一看得见的"取走了却没送到"，所以单独标出来。
 */
function takeFromAgent(
  brain: Brain,
  brainId: string,
  signal: AbortSignal,
): { text: string } | undefined {
  const before = brain.outbounds.agent.length;
  const item = brain.outbounds.agent.shift();
  if (item === undefined) return undefined;

  const queue = `q=${before}→${brain.outbounds.agent.length}`;
  if (signal.aborted) {
    console.warn(
      `[agent] -1 ${brief(brainId)} ${queue} ABORTED(客户端已断开，这条丢了) ${brief(item.text)}`,
    );
    return item;
  }
  console.log(`[agent] -1 ${brief(brainId)} ${queue} ${brief(item.text)}`);
  return item;
}

/**
 * 准备要念的文本：先过 `forTts`（`<!-- disable voice -->` 段不念），再交给分句服务装箱。
 *
 * 返回空数组 = 整段都不该念（调用点自己决定是"跳过"还是"回 empty"）。
 */
async function chunkForTts(text: string, signal: AbortSignal): Promise<string[]> {
  const spoken = Format.forTts(text);
  if (spoken.trim() === "") return [];
  return splitForTts(spoken, signal);
}

type AgentItem = Brain["inbounds"]["agent"][number];

/** 一条消息最多试几次（分句或第一块 TTS 连续失败就不再挡着后面的消息）。 */
const MAX_ATTEMPTS = 3;

/**
 * 把没送出去的消息放回头部。
 *
 * **只有还没吐出第一帧时才能放回**——已经发了一半的再放回会让客户端把前半句听两遍。
 * 客户端自己断开的（`signal.aborted`）不算失败：这条还没送到，留着下次。
 */
function requeue(brain: Brain, brainId: string, item: AgentItem, signal: AbortSignal): void {
  if (signal.aborted) {
    brain.inbounds.agent.unshift(item);
    return;
  }

  item.attempts = (item.attempts ?? 0) + 1;
  if (item.attempts >= MAX_ATTEMPTS) {
    console.error(`[tts] ${brief(brainId)} 连续 ${item.attempts} 次失败，丢掉 ${brief(item.text)}`);
    return;
  }
  brain.inbounds.agent.unshift(item);
}

/**
 * 把一条消息念成帧。
 *
 * 第一帧带**原始**文本（`forTts` 之前的那份）——念出来的可能只是其中一部分，但客户端要显示
 * 的是整条回复；之后每帧只有音频。
 */
async function* speak(
  brain: Brain,
  brainId: string,
  item: AgentItem,
  signal: AbortSignal,
): AsyncGenerator<{ text?: string; audio?: Uint8Array }> {
  let chunks: string[];
  try {
    chunks = await chunkForTts(item.text, signal);
  } catch (cause) {
    requeue(brain, brainId, item, signal);
    throw cause; // 一帧都没发出去：交给路由变成 502
  }

  if (chunks.length === 0) {
    // 整条都被静音了：不合成，但原始文本还是要给客户端（它得显示出来）。
    console.warn(`[tts] ${brief(brainId)} 整段都被静音了，只发文本 ${brief(item.text)}`);
    yield { text: item.text };
    return;
  }

  const voice = item.voice ?? process.env.TTS_VOICE;
  if (voice === undefined || voice === "") {
    console.warn(`[tts] ${brief(brainId)} 没有音色可用，只发文本 ${brief(item.text)}`);
    yield { text: item.text };
    return;
  }

  for (const [index, chunk] of chunks.entries()) {
    if (signal.aborted) return; // 客户端断了：剩下的不合成

    let audio: Uint8Array;
    try {
      ({ audio } = await callVoiceGen(chunk, voice, { signal }));
    } catch (cause) {
      // 第一块就失败：还没发出去任何东西，整条放回去下次再试。
      if (index === 0) requeue(brain, brainId, item, signal);
      throw cause;
    }

    yield index === 0 ? { text: item.text, audio } : { audio };
  }
}

/**
 * 丢掉入队早于 `before` 的 agent 消息（客户端说"这些我已经跳过了"）。
 *
 * `before` 是**客户端的钟**（UTC 毫秒）——客户端和服务端对过时，所以直接比。
 */
function dropBefore(brain: Brain, brainId: string, before: number | undefined): void {
  if (before === undefined) return;

  const kept = brain.inbounds.agent.filter((item) => item.enqueuedAt >= before);
  const dropped = brain.inbounds.agent.length - kept.length;
  if (dropped === 0) return;

  brain.inbounds.agent.splice(0, brain.inbounds.agent.length, ...kept);
  console.log(
    `[agent] skip ${brief(brainId)} 丢掉 ${dropped} 条早于 ${new Date(before).toISOString()} 的消息`,
  );
}

/** 日志里只留前 60 个字：转录可能很长，别把整段刷进日志。 */
function brief(text: string): string {
  return JSON.stringify(text.length > 60 ? `${text.slice(0, 60)}…` : text);
}

const backgroundTaskState = {
  started: false,
};

export async function startBackgroundTask() {
  if (backgroundTaskState.started) return;
  backgroundTaskState.started = true;

  while (true) {
    await backgroundTaskStep().catch(console.error);
    await new Promise((resolve) => setTimeout(resolve, 35));
  }
}

async function backgroundTaskStep() {
  // 空闲淘汰：别每跳都全表扫（N 大了它自己就是稳定的 CPU 开销），10 秒一次够用。
  if (Date.now() - lastSweepAt > 10_000) {
    lastSweepAt = Date.now();
    evictIdleBrains(lastSweepAt);
  }

  for (const [brainId, brain] of brainsStore) {
    if (brain.dirty === 3) {
      brain.dirty = "in-call";
      const job = async () => {
        try {
          const { warning, evaluatedMaxTokens } = await reviseText(brain);
          if (!warning) {
            if (evaluatedMaxTokens > 10240) {
              await maybeCompression(brain, evaluatedMaxTokens, 10240);
            }
            return;
          }

          pushToAgent(brain, brainId, warning, "warning");
          if (evaluatedMaxTokens > 10240) {
            await maybeCompression(brain, evaluatedMaxTokens, 10240);
          }
        } finally {
          brain.dirty = 0;
        }
      };
      job().catch((e) => console.error(`[revise] ${brief(brainId)} 失败`, e));
    }
  }
}

export const Brains: BrainPorts = {
  async humanToBrain(req, { signal }) {
    const brain = brainOf(req.brain_id);
    const result = await callTranscript(req.audio, {
      signal: AbortSignal.any([signal, AbortSignal.timeout(13000)]),
    });
    SizedQueueOps.push(
      brain.history,
      { kind: "human-audio", audioB64: AudioHelper.toBase64(req.audio) },
      64,
    );

    SizedQueueOps.push(brain.history, { kind: "human-audio-transcript", text: result.text }, 64);

    brain.dirty = incDrity(brain.dirty);

    // 人类打断时没听到的那段，插在给 agent 的文本前面。
    // 可空（不给 / null / 空串都算没有），所以这里判的是"有没有实质内容"。
    const heard = Format.asrToAgentReply(result.text);
    const unheard = req.unheard_text ?? "";
    pushToAgent(
      brain,
      req.brain_id,
      unheard.trim() === "" ? heard : `${Format.unheardText(unheard)}\n${heard}`,
      "asr",
    );

    return { kind: "text", text: result.text };
  },

  async *brainToHuman(req, { signal, waitMs }) {
    const brain = brainOf(req.brain_id);
    const brainId = req.brain_id;
    const deadline = Date.now() + waitMs;

    dropBefore(brain, brainId, req.skip_before);

    while (!signal.aborted) {
      // **原子取走**：两个并发请求不能拿到同一条；失败再放回头部（见 `requeue`）。
      const next = brain.inbounds.agent.shift();
      if (next !== undefined) {
        yield* speak(brain, brainId, next, signal);
        return;
      }

      if (Date.now() >= deadline) return; // 等到超时：路由会发一个 empty 帧
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
  },

  async agentToBrain(req) {
    const brain = brainOf(req.brain_id);
    SizedQueueOps.push(brain.history, { kind: "agent-text", text: req.text }, 64);
    SizedQueueOps.push(
      brain.inbounds.agent,
      { text: req.text, voice: req.voice, enqueuedAt: Date.now() },
      64,
    );
    brain.dirty = incDrity(brain.dirty);
    return { kind: "empty" };
  },

  async brainToAgent(req, { signal }) {
    const brain = brainOf(req.brain_id);

    const brainId = req.brain_id;
    let agentText = takeFromAgent(brain, brainId, signal);
    if (agentText !== undefined) {
      return { kind: "text", text: agentText.text };
    }

    while (brain.outbounds.agent.length === 0) {
      if (signal.aborted) {
        return { kind: "empty" };
      }
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    agentText = takeFromAgent(brain, brainId, signal);
    if (agentText === undefined) {
      return { kind: "empty" };
    }

    return { kind: "text", text: agentText.text };
  },
};
