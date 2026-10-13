# 音频转 Ogg Opus —— 实测数据与加固参数

> 实测日期: 2026-10-13 · 环境: Linux / docker / ffmpeg 6.1.2 (alpine) 与 mwader/static-ffmpeg
> 本文只放**测出来的数**和**怎么测的**，用法看 [packages/audio/README.md](../packages/audio/README.md)。

## TL;DR

- 32 kbps 单声道是语音的甜点；12k 发闷，48k 往上听不出区别。
- `-protocol_whitelist pipe`、`--network none`、`--memory` 这三条都验过真的有用，不是照抄 best practice。
- 杀掉 `docker run` 客户端**不会**杀掉容器；镜像的 entrypoint 必须是 ffmpeg。
- ffmpeg 会**退出码 0** 地吐 0 秒空壳，必须自己读 Ogg 的 granule 才看得出来。

## 码率（语音 30 秒一条，libopus）

| 目标码率 | 实际字节/秒 | 30 秒语音条 | 听感 |
| --- | --- | --- | --- |
| 12k | 1389 | 41 KB | 明显发闷，省流量用 |
| 16k | 1803 | 53 KB | 能用，能听出压缩 |
| 24k | 2557 | 75 KB | 语音的甜点 |
| **32k（默认）** | 3625 | **106 KB** | 人声已经很干净 |
| 48k | 5217 | 153 KB | 语音上听不出更多了 |

- **源的天花板比码率重要**：源本身只有 8/16 kHz 带宽的话，往上加码率买不到东西。
- **码率是目标不是上限**（libopus 是 VBR）：同一个人声样本 24k 目标产出 23.1 kbps（贴住目标），换成高频
  密集的信号能飙到 **56.9 kbps**。容量规划按 `maxOutputBytes` 算。

## 安全：两条边界各自验过

| 层 | 挡什么 | 怎么验的 |
| --- | --- | --- |
| 参数层 | `-protocol_whitelist pipe` 关掉所有"跳去别处取数据"的协议 | 不给它时，一个播放列表形态的输入能让 ffmpeg 去连内网地址（起了 listener，**命中 1 次**）；给了之后报 `Protocol 'http' not on whitelist 'pipe'` |
| 执行层 | `--network none` | 默认网络下容器能连到宿主机网关的 listener；加了之后 `Network unreachable` |
| 执行层 | `--memory` 落到 cgroup | 容器里 `cat /sys/fs/cgroup/memory.max` → `67108864` |

参数层挡不住 ffmpeg 自身的解析漏洞（历史 CVE 全在解复用/解码路径上），只有执行层能。所以
`direct` / `http` 两条路**没有**沙箱，README 里也这么写。

## 执行：踩过的坑

- **杀掉 `docker run` 客户端，容器不会跟着死**：客户端 SIGKILL 之后容器还 `Up`，继续烧 CPU。所以超时必须
  显式 `docker kill --signal KILL <name>`——代码里 `containerExecution` 的 `cleanup` 就是干这个的。
- **镜像的 entrypoint 必须是 ffmpeg**：跑的时候是 `docker run <image> <ffmpeg 的参数>`，靠镜像自己把
  `ffmpeg` 补上。自建镜像少了 `ENTRYPOINT ["ffmpeg"]` 时会去 exec `-hide_banner` 这个"程序"，报
  `exec: "-hide_banner": executable file not found in $PATH`。
- **0 采样但头部合法的输入是个陷阱**：ffmpeg 会**退出码 0** 地吐个只有头部、没有音频页的空壳，
  它连 `OggS` + `OpusHead` 都齐。数 Ogg 页数分不出来（空输出和 0.05 秒的正常输出都是 3 页），
  得读最后一个页的 granule position 减 pre-skip。0 秒在本地就失败，不让空壳流到下游。
- **`-t` 是按帧边界截的**：0.2 秒的输入给 `-t 0.000001` 也照样原样通过，2 秒的才会被截。
  所以 `maxDurationSeconds` 不是毫秒精确的上限。
- **容器净开销约 130 ms**（2 秒音频：direct ~50 ms，走容器 ~180 ms）。

## 镜像选哪个

| 镜像 | 解压后 | pull | 备注 |
| --- | --- | --- | --- |
| `mwader/static-ffmpeg:latest`（默认） | 442 MB | 120 MB | entrypoint 就是 ffmpeg，**镜像里连 shell 都没有**（沙箱里少一个能 exec 的东西），拿来即用 |
| 自建 alpine（`apk add ffmpeg`） | 189 MB | 约 50–60 MB | 小一半，代价是里面有 busybox/sh，而且要自己 build（第一次约一分钟） |

**换镜像 = 换编码器版本**：同一个输入、同样的参数，两个镜像产出的字节不同，**解出来的 PCM 也不同**
（79.6% 的采样差一点，最大差 119/32767 ≈ −49 dBFS，听不出来）。别指望"换个镜像输出不变"。

## 纯 WASM 那条路（`wasm` runner，默认）

`@audio/*` 解码 → libopus 编码 → 内置 Ogg muxer，没有进程、没有容器、没有 ffmpeg。

**默认 + 兜底**：不给 runner 时走这条；它认不出的格式（mp3 / wav / mp4…）自动换 `build`（容器）
再跑一次，实测一条 0.3 秒的 WAV 走兜底共 233 ms（换容器那趟是主要开销）。认不出的格式在 sniff
那一步就返回了，所以第一次尝试不浪费解码。

**实测**（同一段 2.88 秒 webm/opus，本机）：

| 路 | 耗时（3 次） | 输出 |
| --- | --- | --- |
| `wasm` | 37 / 55 / 38 ms | 12111 字节 |
| `direct`（宿主 ffmpeg） | 74 / 82 / 84 ms | 12231 字节 |
| `build`（容器） | 250 / 242 / 261 ms | 12231 字节 |

比 `direct` 快是因为省掉了起进程；输出过我们自己的 Ogg 解析器（时长 2.88s，跟 ffmpeg 那条路一致），
喂给线上 ASR 转写结果也完全正确。

**证与覆盖**（这是选它的唯一硬约束——AAC 的解码器是 GPL，没引）：

| 包 | 证 | 用途 |
| --- | --- | --- |
| `@audio/encode-opus` | MIT（libopus 本身 BSD-3） | PCM → Ogg Opus（带 Ogg muxer，单文件模块） |
| `@audio/decode-webm` | MIT | WebM/Matroska → PCM（Opus、Vorbis 内置） |
| `@audio/decode-opus` | MIT | Ogg Opus → PCM |
| `@audio/decode-aac` | **GPL-2.0** | 被 decode-webm 当**普通依赖**带进来的（faad2） |
| `@audio/decode-ac3` | **GPL-2.0-or-later** | 同上 |
| `@audio/decode-dts` | **GPL-2.0-or-later** | 同上 |
| `@audio/decode-eac3` | LGPL-2.1-or-later | 同上（LGPL，没事） |
| `@audio/decode-mp3` / `-flac` / `-vorbis` | MIT | 同上；目前的嗅探只认 WebM / Ogg Opus，这些还没接进文件级识别 |

**GPL 这件事先搁置**（2026-10-13 决定）：项目还是私用，等开源前再清——计划是自己 vendor、去掉
AAC 那部分自己编 wasm，换掉 `packages/audio/src/implementation/wasm-runner.ts` 一个文件就行
（`@audio` 只在那一个文件里出现）。

**实测覆盖**（默认路 = wasm，认不出就兜底换容器）：

| 输入 | 显式 `wasm` | 默认路 |
| --- | --- | --- |
| WebM/Opus（Chrome 录的） | ✓ 54 ms | ✓ 42 ms（wasm） |
| Matroska + AAC（.mka） | ✓ 61 ms | ✓ 33 ms（wasm，靠 GPL 那个解码器） |
| MP4 + AAC（.m4a，Safari 录的） | ✗ 直接拒（没有 mp4 解复用器） | ✓ 290 ms（兜底到容器） |

内存：输入按 64 KB 切片流式喂，不把整段 PCM 攒在内存里（10 分钟音频的 PCM 是 100 MB 级）。
时间：WASM 是同步的，跑起来掐不断，所以超时只能在片与片之间判。
