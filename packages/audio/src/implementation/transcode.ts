/**
 * 任意音频 → Ogg Opus。**全在这一个文件里**，顺着读就是全部：
 *
 *   argsFor(params)                参数 → ffmpeg 的参数数组（纯函数，不起进程）
 *   plan(runner, args)             参数数组 → 怎么执行：direct 直接 exec；
 *                                  build/image 是在同一个数组前面套一层 `docker run`；
 *                                  http 是 POST 出去。
 *   spawnAndCollect / postForOgg   真的跑，管生命周期：喂 stdin、截住 stdout、
 *                                  超时就杀（容器还要点名杀）、超量就断。
 *   ensureAudible                  出口只有这一个：本地产的、对面返回的，都过同一关。
 *
 * 失败全部归成 AudioError，原始事实（stderr 尾巴、HTTP 状态码）走标准的 cause。
 */
import { execFile, spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import process from "node:process";
import { promisify } from "node:util";

import type { RunnerOptions, RunnerStatus, TranscodeParams } from "../index.ts";
import { AudioError } from "../index.ts";

const execFileAsync = promisify(execFile);

/**
 * 转码参数**全在这里**，公开面一个都不放。
 *
 * 这套输出是给下游（我们的服务）认的，它只有一种口味；摆旋钮出去只会让人以为可以随便调，
 * 而调出来的东西下游不认。真要第二种口味，那是第二个函数的事。
 */
const OUTPUT = {
  bitrateKbps: 32, // 语音的甜点区：16 发闷，48 往上听不出更多（README 有实测表）
  sampleRate: 48_000, // Opus 的原生采样率，别动
  channels: 1, // 语音就是单声道；立体声源也先合并

  // 下面这些是护栏，不是口味。
  maxDurationSeconds: 600, // 超了截断（-t 的语义）。语音条撑死几分钟，别让 10 小时的输入烧 CPU
  timeoutMs: 60_000, // 墙钟预算。10 分钟、25 MB 封顶的输入在这个数里绰绰有余
  maxInputBytes: 25 * 1024 * 1024, // 跟 OpenAI 转写接口的限制对齐
  maxOutputBytes: 32 * 1024 * 1024, // 防意外：32 kbps 的 10 分钟也就 2.4 MB
};

export type Params = typeof OUTPUT;

export interface Limits {
  readonly timeoutMs: number;
  readonly maxOutputBytes: number;
}

/**
 * 参数 → ffmpeg 的参数数组。**这是唯一的参数出口**：direct 直接执行它，docker 把它原样
 * 接在镜像名后面，测试也可以不起进程就检查它。
 *
 * `-protocol_whitelist pipe` 是输入侧的安全大头：它把 http/file/concat 这些协议全关掉。
 * 实测过没有它的时候，一个播放列表形态的输入能让 ffmpeg 去连内网地址（SSRF）；有了它，
 * 连接根本发不出去。
 */
export function argsFor(params: Params = OUTPUT): string[] {
  return [
    "-hide_banner",
    "-loglevel",
    "error",
    // 输入输出都走管道，那就只放行管道：任何"跳去别处取数据"的协议一律拒绝。
    "-protocol_whitelist",
    "pipe",
    "-i",
    "pipe:0",
    // 只要第一条音频轨，封面图之类的顺带忽略。
    "-map",
    "0:a:0",
    "-t",
    String(params.maxDurationSeconds),
    "-ac",
    String(params.channels),
    "-ar",
    String(params.sampleRate),
    "-c:a",
    "libopus",
    "-b:a",
    `${params.bitrateKbps}k`,
    "-application",
    "voip",
    // opus 这个 muxer 就是 Ogg Opus（ffmpeg -muxers 里写的是 "opus  Ogg Opus"）。
    // 输出没有文件名可推断，必须显式写。
    "-f",
    "opus",
    "pipe:1",
  ];
}

/** 补齐默认值。逐项 `??` 而不是 `{...OUTPUT, ...params}`：后者遇到显式的 undefined 会覆盖掉默认值。 */
function withDefaults(params: TranscodeParams): Params {
  return {
    bitrateKbps: params.bitrateKbps ?? OUTPUT.bitrateKbps,
    sampleRate: params.sampleRate ?? OUTPUT.sampleRate,
    channels: params.channels ?? OUTPUT.channels,
    maxDurationSeconds: params.maxDurationSeconds ?? OUTPUT.maxDurationSeconds,
    timeoutMs: params.timeoutMs ?? OUTPUT.timeoutMs,
    maxInputBytes: params.maxInputBytes ?? OUTPUT.maxInputBytes,
    maxOutputBytes: params.maxOutputBytes ?? OUTPUT.maxOutputBytes,
  };
}

// ── 怎么执行 ────────────────────────────────────────────────────────────────

/** 一次执行要的东西：命令、参数，以及超时/超量时的额外清理。 */
export interface Execution {
  readonly command: string;
  readonly argv: readonly string[];
  /** 光杀客户端不够时要额外执行的东西——见下面容器那条注释。 */
  readonly cleanup?: readonly string[];
}

type Plan =
  | { readonly kind: "direct"; readonly execution: Execution }
  | {
      readonly kind: "container";
      readonly execution: Execution;
      readonly image: string;
      readonly engineVersion: string;
    }
  | { readonly kind: "http"; readonly url: string }
  | { readonly kind: "unavailable"; readonly detail: string };

/** direct：参数数组就是全部，跑宿主机的 ffmpeg。 */
export function directExecution(bin: string, args: readonly string[]): Execution {
  return { command: bin, argv: args };
}

/**
 * container：**同一个参数数组**，前面套一层 `docker run`。
 *
 * 加固参数每一条都对应一类能在容器里发生的事故，删之前先想清楚。
 * `--user 65534:65534` 配合只读根：镜像里得是静态二进制或者至少全局可执行的——自建的
 * alpine 镜像和 mwader/static-ffmpeg 都满足。
 *
 * 镜像自己的 entrypoint 必须是 ffmpeg：我们是把 ffmpeg 的参数直接接在镜像名后面的。
 * 少了这一环，容器会去 exec `-hide_banner` 这个"程序"（实测报错就是
 * `exec: "-hide_banner": executable file not found in $PATH`）。
 */
export function containerExecution(
  engine: string,
  image: string,
  args: readonly string[],
): Execution {
  const name = `might-ffmpeg-${randomBytes(6).toString("hex")}`;
  return {
    command: engine,
    argv: [
      "run",
      "--rm",
      "-i", // 靠 stdin/stdout 传音频
      "--name",
      name,
      // 禁网：硬隔离。ffmpeg 自己的解析漏洞、我们没想到的协议，都出不了这台机器。
      "--network",
      "none",
      // cgroup 限额。swap 给同值，否则容器能靠 swap 把内存上限架空。
      "--memory",
      "512m",
      "--memory-swap",
      "512m",
      "--cpus",
      "1",
      "--pids-limit",
      "64",
      // 根文件系统只读；需要写的地方只放一小块 /tmp，且不可执行。
      "--read-only",
      "--tmpfs",
      "/tmp:rw,noexec,nosuid,size=64m",
      "--cap-drop",
      "ALL",
      "--security-opt",
      "no-new-privileges",
      "--user",
      "65534:65534",
      image,
      ...args,
    ],
    // 不注意就会漏：**杀掉 `docker run` 这个客户端，容器不会跟着死**，它会变成孤儿继续
    // 烧 CPU（实测过）。所以超时的时候得点名把容器也杀了。
    cleanup: [engine, "kill", "--signal", "KILL", name],
  };
}

/** build 模式构建出来的镜像名。 */
const BUILT_IMAGE = "might-ffmpeg:alpine";

/** image 模式不给镜像时的默认值。 */
const DEFAULT_IMAGE = "mwader/static-ffmpeg:latest";
const DEFAULT_ENGINE = "docker";

/**
 * 自建镜像的 Dockerfile。写成常量而不是文件：`docker build -` 直接从 stdin 读，
 * 不用管文件在安装后还在不在。构建要网络（拉 alpine + apk 包，约 50 MB），
 * **跑的时候是禁网的**——构建和使用分得很开，这是刻意的。
 */
const DOCKERFILE = [
  "FROM alpine:3.21",
  "RUN apk add --no-cache ffmpeg",
  'ENTRYPOINT ["ffmpeg"]',
  "",
].join("\n");

/** 构建超时。apk 下载加解包，慢网络下也要留够。 */
const BUILD_TIMEOUT_MS = 10 * 60 * 1000;

/**
 * 选路，并把参数数组变成"怎么执行"。**地址一律是"调用点给的 > 环境变量 > 默认"**，
 * 所以生产里通常只有 MIGHT_FFMPEG_RUNNER 一个变量，代码里连 runner 都不用写。
 */
async function plan(runner: RunnerOptions | undefined, args: readonly string[]): Promise<Plan> {
  const kind = runner?.kind ?? process.env["MIGHT_FFMPEG_RUNNER"] ?? "build";
  // kind 可能是环境变量给的，所以这里窄化不了 runner 的联合类型，逐个字段各取各的。
  const engine =
    (runner?.kind === "build" || runner?.kind === "image" ? runner.engine : undefined) ??
    DEFAULT_ENGINE;

  switch (kind) {
    case "direct": {
      const bin =
        (runner?.kind === "direct" ? runner.bin : undefined) ??
        process.env["MIGHT_FFMPEG_BIN"] ??
        (await firstOnPath("ffmpeg"));
      if (bin === undefined) {
        return { kind: "unavailable", detail: "PATH 里没有 ffmpeg，而且没给 bin" };
      }
      return { kind: "direct", execution: directExecution(bin, args) };
    }

    case "build":
    case "image": {
      const image =
        kind === "image"
          ? ((runner?.kind === "image" ? runner.image : undefined) ??
            process.env["MIGHT_FFMPEG_IMAGE"] ??
            DEFAULT_IMAGE)
          : BUILT_IMAGE;

      // 两种都要容器运行时。连不上就直接失败，**不会悄悄退化成 direct**。
      const engineVersion = await dockerVersion(engine);
      if (engineVersion === undefined) {
        return {
          kind: "unavailable",
          detail: `${engine} 守护进程连不上。要跑不沙箱的用 { kind: "direct" }`,
        };
      }

      if (await imageExists(engine, image)) {
        // 有就直接用。
      } else if (kind === "image") {
        return {
          kind: "unavailable",
          detail: `本地没有镜像 ${image}（要拉的话：${engine} pull ${image}）`,
        };
      } else {
        const failure = await buildImage(engine); // 自建镜像没有就现构建一次，之后复用
        if (failure !== undefined) return { kind: "unavailable", detail: failure };
      }

      return {
        kind: "container",
        execution: containerExecution(engine, image, args),
        image,
        engineVersion,
      };
    }

    case "http": {
      const url =
        (runner?.kind === "http" ? runner.url : undefined) ?? process.env["MIGHT_FFMPEG_URL"];
      if (url === undefined || url === "") {
        throw new AudioError({
          code: "invalid-input",
          field: "runner.url",
          detail: "http runner 要有 url（或者 MIGHT_FFMPEG_URL）",
        });
      }
      return { kind: "http", url };
    }

    default:
      // 环境变量写错了要出声，不能悄悄按 build 走——部署脚本里的错别字不该变成"沙箱没了"。
      throw new AudioError({ code: "invalid-input", detail: `运行方式不认识：${kind}` });
  }
}

async function dockerVersion(engine: string): Promise<string | undefined> {
  try {
    const { stdout } = await execFileAsync(engine, ["version", "--format", "{{.Server.Version}}"], {
      timeout: 5_000,
    });
    const version = stdout.trim();
    return version === "" ? undefined : version;
  } catch {
    return undefined;
  }
}

async function firstOnPath(bin: string): Promise<string | undefined> {
  try {
    const { stdout } = await execFileAsync("which", [bin], { timeout: 5_000 });
    const found = stdout.trim();
    return found === "" ? undefined : found;
  } catch {
    return undefined;
  }
}

async function imageExists(engine: string, image: string): Promise<boolean> {
  try {
    await execFileAsync(engine, ["image", "inspect", image, "--format", "{{.Id}}"], {
      timeout: 5_000,
    });
    return true;
  } catch {
    return false;
  }
}

/** 构建自建镜像。成功返回 undefined，失败返回一句能拿去报错的话。 */
async function buildImage(engine: string): Promise<string | undefined> {
  const child = spawn(engine, ["build", "-t", BUILT_IMAGE, "-"], {
    stdio: ["pipe", "ignore", "pipe"],
  });
  let stderr = "";
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (text: string) => {
    stderr = (stderr + text).slice(-4_096); // 只留尾巴
  });
  child.stdin.on("error", () => {});
  child.stdin.end(DOCKERFILE);

  const timer = setTimeout(() => child.kill("SIGKILL"), BUILD_TIMEOUT_MS);
  try {
    const code = await exitCodeOf(child);
    if (code === 0) return undefined;
    return `构建自建镜像 ${BUILT_IMAGE} 失败（退出码 ${code}）：${stderr.trim() || "没有输出"}`;
  } catch (cause) {
    return `构建自建镜像失败：${messageOf(cause)}`;
  } finally {
    clearTimeout(timer);
  }
}

// ── 跑起来 ──────────────────────────────────────────────────────────────────

/** 跑完（或被杀）之后交回来的事实。**失败不在这层归因**，只描述。 */
export interface Result {
  readonly bytes: Buffer;
  readonly timedOut: boolean;
  readonly overflowed: boolean;
  /** 有值就是这次没成：本地是 stderr 尾巴，http 是状态码加响应片段。 */
  readonly failed?: string;
  readonly exitCode?: number;
}

/**
 * 把命令跑起来，喂进 input，把 stdout 收回来。
 *
 * 生命周期都在这一个函数里，四件事：进程起不来（ENOENT）走 error 事件而不是退出码；
 * stdout 超过上限就停收并杀进程（上限的意义就在这，不然就是替对方吃内存）；超时杀；
 * 以及**杀要杀干净**——整组一起杀，容器还要跑它自己的 cleanup。
 */
export async function spawnAndCollect(
  execution: Execution,
  input: Uint8Array,
  limits: Limits,
): Promise<Result> {
  const child = spawn(execution.command, [...execution.argv], {
    stdio: ["pipe", "pipe", "pipe"],
    detached: true, // 自成进程组，好一次杀掉它和它拉起来的东西
  });

  const chunks: Buffer[] = [];
  let size = 0;
  let overflowed = false;
  let timedOut = false;
  let stderrTail = "";
  let stopped = false;

  child.stdout.on("data", (chunk: Buffer) => {
    size += chunk.length;
    if (size > limits.maxOutputBytes) {
      if (!overflowed) {
        overflowed = true;
        void stop();
      }
      return;
    }
    chunks.push(chunk);
  });

  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (text: string) => {
    stderrTail = (stderrTail + text).slice(-8_192); // 只留尾巴，别把内存交给对方
  });

  // 进程已经死了还往里写会抛 EPIPE，把整个进程带走，所以 stdin 也要挂个 handler。
  child.stdin.on("error", () => {});
  child.stdin.end(input);

  const exited = exitCodeOf(child);

  async function stop(): Promise<void> {
    if (stopped) return;
    stopped = true;
    if (execution.cleanup !== undefined) {
      try {
        await execFileAsync(execution.cleanup[0] as string, execution.cleanup.slice(1), {
          timeout: 5_000,
        });
      } catch {
        // 容器已经自己退了，或者根本没起起来——都不影响下一步。
      }
    }
    killTree(child);
  }

  const timer = setTimeout(() => {
    timedOut = true;
    void stop();
  }, limits.timeoutMs);

  try {
    const exitCode = await exited;
    return {
      bytes: Buffer.concat(chunks),
      timedOut,
      overflowed,
      ...(exitCode === 0 ? {} : { failed: stderrTail.trim() || `退出码 ${exitCode}` }),
      exitCode,
    };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * HTTP runner：**multipart 上行，音频下行**。
 *
 * ```
 * POST <url>   multipart/form-data
 *   文本段：bitrateKbps / sampleRate / channels / maxDurationSeconds
 *   文件段：audio，content-type: application/octet-stream
 *           （故意不带扩展名：格式是嗅探出来的，带个 .m4a 只会诱导对面按扩展名猜）
 * → 2xx 的 body 就是 Ogg Opus（流式读，边读边卡上限）
 * ```
 *
 * ⚠ 这一路**不提供沙箱**，它只是把执行搬走了。那边跑不跑容器、禁不禁网是那个服务自己的
 * 事，而且**别把一个裸的 ffmpeg 包成 HTTP 服务**——那等于把风险从进程搬到了网络里，
 * 还多了一个能对内网发请求的跳板。
 */
export async function postForOgg(
  url: string,
  params: UpstreamParams,
  input: Uint8Array,
  limits: Limits,
): Promise<Result> {
  // 用平台自带的 FormData：boundary、段头、转义都由 undici 写，比手搓可靠。
  const form = new FormData();
  form.set("bitrateKbps", String(params.bitrateKbps));
  form.set("sampleRate", String(params.sampleRate));
  form.set("channels", String(params.channels));
  form.set("maxDurationSeconds", String(params.maxDurationSeconds));
  // 故意不带扩展名：格式是嗅探出来的，带个 .m4a 只会诱导对面按扩展名猜。
  // TS 的 BlobPart 不认 SharedArrayBuffer 背书的视图（浏览器里 Blob 确实不支持它）；
  // Node 这边 undici 照收，而且字节本来就会被拷进 Blob 里，不用先 slice 再拷第二份。
  form.set(
    "audio",
    new Blob([input as Uint8Array<ArrayBuffer>], { type: "application/octet-stream" }),
    "audio",
  );

  const signal = AbortSignal.timeout(limits.timeoutMs);

  let response: Response;
  try {
    response = await fetch(url, { method: "POST", body: form, signal });
  } catch (cause) {
    // 发不出去是部署问题（跟容器连不上同类）；读一半超时才是这次没跑完。
    if (signal.aborted) return { bytes: Buffer.alloc(0), timedOut: true, overflowed: false };
    throw new AudioError({ code: "ffmpeg-missing", detail: `转码服务连不上：${url}` }, { cause });
  }

  const chunks: Buffer[] = [];
  let size = 0;
  // content-length 有就先看一眼，省得白读一遍再掐断。
  let overflowed = Number(response.headers.get("content-length") ?? "0") > limits.maxOutputBytes;
  let timedOut = false;

  if (!overflowed && response.body !== null) {
    try {
      for await (const chunk of response.body) {
        const bytes = Buffer.from(chunk as Uint8Array);
        size += bytes.length;
        if (size > limits.maxOutputBytes) {
          overflowed = true;
          await response.body.cancel().catch(() => {}); // 剩下的不要了：对面可能永远发不完
          break;
        }
        chunks.push(bytes);
      }
    } catch (cause) {
      if (!signal.aborted) throw cause;
      timedOut = true;
    }
  }
  if (timedOut) return { bytes: Buffer.alloc(0), timedOut: true, overflowed: false };

  const bytes = Buffer.concat(chunks);
  return {
    bytes,
    timedOut: false,
    overflowed,
    ...(response.ok ? {} : { failed: `HTTP ${response.status}：${snippetOf(bytes)}` }),
    exitCode: response.status,
  };
}

/** 上行带的四个字段——参数发出去的就这四个，本地那些护栏跟对面无关。 */
export type UpstreamParams = Pick<
  Params,
  "bitrateKbps" | "sampleRate" | "channels" | "maxDurationSeconds"
>;

/** 服务的错误响应可能是一整页 HTML，只取一小段；里面的换行会污染日志。 */
function snippetOf(body: Buffer): string {
  const text = body.subarray(0, 200).toString("utf8").replace(/\s+/g, " ").trim();
  return text === "" ? "（没有内容）" : text;
}

// ── 出口 ────────────────────────────────────────────────────────────────────

/**
 * 是不是 Ogg Opus 字节。
 *
 * 只看 `OggS` 不够：Ogg 是容器，里面还能装 Vorbis / FLAC / Theora。`OpusHead`
 * 一定出现在第一个页里，两个一起看才算数。
 */
export function isOggOpus(input: Uint8Array): boolean {
  const head = Buffer.from(input.subarray(0, 64)).toString("latin1");
  return head.startsWith("OggS") && head.includes("OpusHead");
}

/**
 * 读 Ogg Opus 的时长（秒）；结构不像 Ogg Opus 就返回 undefined。
 *
 * 只需要走页头，不用解音频：最后那个页的 granule position 是"总共多少个 48kHz 采样"，
 * 减去 OpusHead 里的 pre-skip（编码器延迟，解码器要丢掉的那几个采样）就是真实时长。
 *
 * 为什么不用"数 OggS 页数"糊弄过去：实测空输出（被 -t 截成 0 秒）和 0.05 秒的正常输出
 * 都是 3 页（头部页 + OpusTags 页 + 空的收尾页），数页数根本分不出来。
 */
export function oggOpusDuration(input: Uint8Array): number | undefined {
  const view = new DataView(input.buffer, input.byteOffset, input.byteLength);
  let offset = 0;
  let preskip: number | undefined;
  let lastGranule = 0n;

  while (offset + 27 <= input.length && magicOf(input, offset, 4) === "OggS") {
    const granule = view.getBigUint64(offset + 6, true);
    const segmentCount = view.getUint8(offset + 26);
    let bodySize = 0;
    for (let i = 0; i < segmentCount; i++) bodySize += view.getUint8(offset + 27 + i);
    const body = offset + 27 + segmentCount;

    if (preskip === undefined && magicOf(input, body, 8) === "OpusHead") {
      preskip = view.getUint16(body + 10, true);
    }
    // granule 全 1 表示"这个页还没收尾"，不是真实时长。
    if (granule !== 0xffffffffffffffffn) lastGranule = granule;
    offset = body + bodySize;
  }

  if (preskip === undefined) return undefined;
  const samples = lastGranule - BigInt(preskip);
  return samples <= 0n ? 0 : Number(samples) / 48_000;
}

function magicOf(input: Uint8Array, offset: number, length: number): string {
  return Buffer.from(input.subarray(offset, offset + length)).toString("latin1");
}

/**
 * 出口只有这一个：本地产的、对面返回的，都过同一关。
 *
 * 退出码 0（或者 2xx）也可能是空产出——比如被 -t 截成 0 秒，或者输入的音频轨本身是空的。
 * 那种文件结构完全合法、还能通过 isOggOpus，只是没有任何声音。宁可在这里失败，
 * 也别把一段空音频递给下游，让它在更远的地方炸。
 */
function ensureAudible(bytes: Buffer): Buffer {
  const seconds = oggOpusDuration(bytes);
  if (seconds === undefined) {
    throw new AudioError(
      { code: "transcode-failed" },
      { cause: `输出不是 Ogg Opus（${bytes.length} 字节）` },
    );
  }
  if (seconds === 0) {
    throw new AudioError(
      { code: "transcode-failed" },
      { cause: "转出来是 0 秒：输入里没有可用的音频，或者被 maxDurationSeconds 截没了" },
    );
  }
  return bytes;
}

// ── 公开的两个函数 ──────────────────────────────────────────────────────────

export async function convertToOggOpus(
  input: Uint8Array,
  runner?: RunnerOptions,
  params: TranscodeParams = {},
): Promise<Uint8Array> {
  if (input.length === 0) {
    throw new AudioError({ code: "invalid-input", detail: "音频是空的" });
  }
  const options = withDefaults(params);
  if (input.length > options.maxInputBytes) {
    throw new AudioError({ code: "too-large", bytes: input.length, limit: options.maxInputBytes });
  }

  const chosen = await plan(runner, argsFor(options));
  if (chosen.kind === "unavailable") {
    throw new AudioError({ code: "ffmpeg-missing", detail: chosen.detail });
  }

  let result: Result;
  try {
    result =
      chosen.kind === "http"
        ? await postForOgg(chosen.url, options, input, options)
        : await spawnAndCollect(chosen.execution, input, options);
  } catch (cause) {
    // 进程都起不来（ENOENT）是部署问题，不是这个文件的问题。
    if (errorCodeOf(cause) === "ENOENT") {
      const what = chosen.kind === "http" ? chosen.url : chosen.execution.command;
      throw new AudioError({ code: "ffmpeg-missing", detail: `找不到 ${what}` }, { cause });
    }
    throw cause;
  }

  if (result.overflowed) {
    throw new AudioError({ code: "output-too-large", limit: options.maxOutputBytes });
  }
  if (result.timedOut) {
    throw new AudioError({ code: "timed-out", timeoutMs: options.timeoutMs });
  }
  if (result.failed !== undefined) {
    throw new AudioError(
      {
        code: "transcode-failed",
        ...(result.exitCode === undefined ? {} : { exitCode: result.exitCode }),
      },
      { cause: result.failed },
    );
  }
  return ensureAudible(result.bytes);
}

/** 探测结果按配置缓存：`docker version` 每次都要问守护进程，没必要每个文件问一遍。 */
const probes = new Map<string, Promise<Plan>>();

/**
 * 查现在会走哪条路，以及为什么。**只看路，不发请求、不跑转码**。
 *
 * **进程启动时断言一次**，别等第一个用户请求才发现生产环境没跑在容器里：
 *
 * ```ts
 * const status = await inspectRunner();
 * if (status.kind !== "container" && status.kind !== "http") {
 *   throw new Error(`ffmpeg 没跑在沙箱里：${status.kind} ${status.detail ?? ""}`);
 * }
 * ```
 *
 * http 这一路这里**只查得到配置，查不到那边到底有没有沙箱**：报 http 是"配好了"，
 * 不是"安全了"。
 */
export async function inspectRunner(runner?: RunnerOptions): Promise<RunnerStatus> {
  const key = JSON.stringify(runner ?? null);
  let pending = probes.get(key);
  if (pending === undefined) {
    pending = plan(runner, []);
    probes.set(key, pending);
  }

  const chosen = await pending;
  switch (chosen.kind) {
    case "unavailable":
      return { kind: "unavailable", detail: chosen.detail };
    case "http":
      return { kind: "http", target: chosen.url };
    case "direct":
      return { kind: "direct", target: chosen.execution.command };
    case "container":
      return { kind: "container", target: chosen.image, engineVersion: chosen.engineVersion };
  }
}

// ── 小工具 ──────────────────────────────────────────────────────────────────

function exitCodeOf(child: ReturnType<typeof spawn>): Promise<number> {
  return new Promise((resolve, reject) => {
    child.on("error", reject); // 进程起不来走这里，不是退出码
    child.on("close", (code) => resolve(code ?? -1));
  });
}

/** 杀了就杀干净：先整组，整组不行再杀这一个。 */
function killTree(child: ReturnType<typeof spawn>): void {
  if (child.pid !== undefined) {
    try {
      process.kill(-child.pid, "SIGKILL"); // 负号 = 整个进程组
      return;
    } catch {
      // 组已经没了，或者压根没建成——退回杀单个。
    }
  }
  child.kill("SIGKILL");
}

function errorCodeOf(cause: unknown): string | undefined {
  if (cause === null || typeof cause !== "object") return undefined;
  const code = (cause as { code?: unknown }).code;
  return typeof code === "string" ? code : undefined;
}

function messageOf(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}
