/**
 * WASM runner：`@audio/*` 解码 → libopus 编码 → 内置 Ogg muxer，全在原地跑。
 *
 * **`@audio` 只在这个文件里出现**（静态 import，就这三行）。以后要 vendor——自己编一个
 * 去掉 AAC 那部分的 wasm——换这一个文件就行，外面不认识这些包。
 *
 * 没有进程、没有容器、没有 ffmpeg：**沙箱就是 WASM 本身**——除了我们喂进去的那块内存，
 * 它碰不到文件系统、网络、进程，也不需要 cgroup 去拦它。
 *
 * 只能转**装了解码器的格式**。装的是 MIT / BSD 那几个；AAC 的解码器是 GPL-2.0，没引——
 * 认不出来的时候要说清楚，别让调用点自己去猜（更别把解码器内部的 TypeError 漏出去）。
 *
 * 输入按 64 KB 切片流式喂，不把整段 PCM 攒在内存里（10 分钟音频的 PCM 是 100 MB 级）。
 * 超时只能在片与片之间判：WASM 是同步的，跑起来掐不断。
 */
import { decoder as openOpus } from "@audio/decode-opus";
import { decoder as openWebm } from "@audio/decode-webm";
import encodeOpus from "@audio/encode-opus";

/** 跟 transcode.ts 的 Result 同一个形状，但这里不 import 它——这个文件要能单独换掉。 */
export interface WasmResult {
  readonly bytes: Buffer;
  readonly timedOut: boolean;
  readonly overflowed: boolean;
  readonly failed?: string;
}

export interface WasmParams {
  readonly bitrateKbps: number;
  readonly maxDurationSeconds: number;
  readonly timeoutMs: number;
  readonly maxOutputBytes: number;
}

interface WasmAudio {
  readonly channelData: Float32Array[];
  readonly sampleRate: number;
}

interface WasmDecoder {
  /** Matroska 里那些不是内置的编码（AAC、MP3……），这一下返回的是 Promise：解码器要现加载。 */
  decode(bytes: Uint8Array): WasmAudio | Promise<WasmAudio>;
  flush(): WasmAudio | Promise<WasmAudio>;
  free(): void;
}

interface WasmEncoder {
  encode(channelData: Float32Array[]): Uint8Array;
  flush(): Uint8Array;
  free(): void;
}

/** 只看前几个字节：WebM 是 EBML 的魔数，Ogg Opus 是 OggS + OpusHead。 */
function sniff(input: Uint8Array): "webm" | "opus" | undefined {
  if (Buffer.from(input.subarray(0, 4)).equals(Buffer.from([0x1a, 0x45, 0xdf, 0xa3])))
    return "webm";
  const head = Buffer.from(input.subarray(0, 64)).toString("latin1");
  if (head.startsWith("OggS") && head.includes("OpusHead")) return "opus";
  return undefined;
}

/** 认不出的格式不是异常，是"这条路做不了"——交回 failed，让上层决定换哪条路。 */
export async function runWasm(params: WasmParams, input: Uint8Array): Promise<WasmResult> {
  const format = sniff(input);
  if (format === undefined) {
    return miss("wasm 这条路认不出这个格式（只认 WebM 和 Ogg Opus）");
  }

  let decoder: WasmDecoder;
  try {
    decoder = format === "webm" ? await openWebm() : await openOpus();
  } catch (cause) {
    return miss(`wasm 解码器起不来：${messageOf(cause)}`);
  }

  const chunks: Buffer[] = [];
  const maxSamples = params.maxDurationSeconds * 48_000; // Opus 永远是 48 kHz
  const started = Date.now();
  let encoder: WasmEncoder | undefined;
  let size = 0;
  let fed = 0; // 已经喂进编码器的采样数，用来做 -t 那个截断
  let overflowed = false;
  let timedOut = false;

  const take = (channelData: Float32Array[]): void => {
    let frames = channelData;
    if (fed + (channelData[0]?.length ?? 0) > maxSamples) {
      // 超过时长的部分截掉——`-t` 的语义，按帧边界截，不是精确到毫秒。
      const keep = maxSamples - fed;
      if (keep <= 0) return;
      frames = channelData.map((channel) => channel.subarray(0, keep));
    }
    fed += frames[0]?.length ?? 0;

    const bytes = Buffer.from(encoder?.encode(frames) ?? []);
    size += bytes.length;
    if (size > params.maxOutputBytes) overflowed = true;
    else chunks.push(bytes);
  };

  /** 喂一块 PCM。空块要挡掉：容器头部那几片、以及没有剩余音频时的 flush() 都是空的。 */
  const feed = async (pending: WasmAudio | Promise<WasmAudio>): Promise<void> => {
    const pcm = await pending;
    if ((pcm?.channelData?.[0]?.length ?? 0) === 0) return;
    // 编码器是**第一块真音频到手时**才建的：采样率和声道数就在那块里。
    encoder ??= await encodeOpus({
      sampleRate: pcm.sampleRate,
      channels: pcm.channelData.length,
      bitrate: params.bitrateKbps,
      application: "voip", // 跟 ffmpeg 那条路的 -application voip 对齐
    });
    take(pcm.channelData);
  };

  try {
    for (let at = 0; at < input.length; at += 64 * 1024) {
      if (overflowed || fed >= maxSamples) break;
      if (Date.now() - started > params.timeoutMs) {
        timedOut = true;
        break;
      }
      try {
        await feed(decoder.decode(input.subarray(at, at + 64 * 1024)));
      } catch (cause) {
        // 解到一半才发现不行：WebM 里装的是 AAC（解码器是 GPL，没引）、文件坏了、或者
        // 解码器自己对不认识的编码抛了个没头没尾的 TypeError。
        return miss(`wasm 解不了这个文件：${messageOf(cause)}`);
      }
    }

    // flush 不能省：Ogg 那种小文件，解码器会把音频攒到最后一次才吐出来，不调它就什么都不剩。
    if (!overflowed && !timedOut) {
      await feed(decoder.flush());
      if (encoder !== undefined) {
        const tail = Buffer.from(encoder.flush());
        size += tail.length;
        if (size > params.maxOutputBytes) overflowed = true;
        else chunks.push(tail);
      }
    }
  } finally {
    decoder.free();
    encoder?.free();
  }

  if (overflowed) return { bytes: Buffer.concat(chunks), timedOut, overflowed };
  if (timedOut) return { bytes: Buffer.concat(chunks), timedOut, overflowed };
  if (encoder === undefined) {
    // 一个采样都没解出来。最像的原因是编码不是 Opus/Vorbis（AAC 那种解码器是 GPL，没引），
    // 也有可能是文件本身没有音频轨——两种都不该悄悄返回 0 字节。
    return miss("wasm 没从这个文件里解出音频（编码不是 Opus / Vorbis？）");
  }
  return { bytes: Buffer.concat(chunks), timedOut, overflowed };
}

function miss(reason: string): WasmResult {
  return {
    bytes: Buffer.alloc(0),
    timedOut: false,
    overflowed: false,
    failed: `${reason}；换 build / direct 跑`,
  };
}

function messageOf(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}
