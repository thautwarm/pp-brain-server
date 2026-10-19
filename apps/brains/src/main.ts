#!/usr/bin/env node
/**
 * @might/brains 的入口：把路由、brain、后台任务接起来。
 *
 *   node --env-file=.env apps/brains/src/main.ts
 *
 * 配置在启动时一次断言完——缺什么、错什么都直接说清楚再退出，不要等第一个请求才炸成 502。
 * （env 不会自动加载：要么上面那个 `--env-file`，要么 docker compose 的 `env_file`。）
 */
import process from "node:process";

import { serve } from "@hono/node-server";

import { Brains, startBackgroundTask } from "./brain-center.ts";
import { createBrainRouter } from "./http.ts";
import { installLlmLogger } from "./llm-log.ts";

/** 配置不对就别起服务：半启动的 server 比压根不启动难查得多。 */
function die(message: string): never {
  console.error(`\n  ✗ ${message}\n`);
  process.exit(1);
}

function required(name: string): string {
  const value = process.env[name];
  if (value === undefined || value === "") die(`缺少环境变量 ${name}（见 .env）`);
  return value;
}

function envInt(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw === "") return fallback;

  const value = Number(raw);
  if (!Number.isInteger(value) || value <= 0)
    die(`${name} 要是正整数，实际是 ${JSON.stringify(raw)}`);
  return value;
}

// 连不上 STT/TTS/chat 的部署没有存在的意义，早点说清楚。
required("STT_API_BASE_URL");
required("TTS_API_BASE_URL");
required("MIGHT_CHAT_API_KEY");
required("MIGHT_CHAT_API_BASE_URL");
// 默认音色。必填是有原因的：@ai-sdk/openai 的 speech 在 voice 为 undefined 时会自己塞
// "alloy"，而自建的 TTS 未必认这个名字 —— 宁可启动时就报出来。
required("TTS_VOICE");

// 没有 brain 清单：`brain_id` 由客户端随便给，第一次出现时现建（空闲 2 小时自动卸载，见
// brain-center）。所以启动时没什么可读的配置文件。

const token = process.env.MIGHT_BRAINS_TOKEN ?? ""; // 空 = 不启用鉴权（规格 §0.2）
const port = envInt("MIGHT_BRAINS_PORT", 8787);

// 排查用：MIGHT_LOG_LLM=1 时把发往 chat 模型的请求/响应原样打到日志里（默认关）。
installLlmLogger();

const app = createBrainRouter({
  ports: Brains,
  token,
  pollTimeoutMs: envInt("MIGHT_BRAINS_POLL_TIMEOUT_MS", 25000),
});

// 修订和空闲淘汰都跑在这里面。它每步自己吞异常，所以不用 await，也不用管它的返回值。
startBackgroundTask();

// **容器里 node 就是 PID 1**，而内核不对 PID 1 施加"默认动作"信号——我们又没装 handler，
// 于是 SIGTERM 被直接丢掉，`docker stop` 只能等满默认的 10 秒 grace 再 SIGKILL
// （`docker compose stop` 实测 10.2 秒、退出码 137 就是这个）。
// 装个 handler 是这个问题最短的解法；`init: true` 也行（见 docker-compose.yaml）。
//
// 直接退出、不做 graceful drain：这个进程的状态全在内存里，重启本来就清零，没必要为了
// 让在途的请求（长轮询 25 秒；流式回复可能更久）跑完而再拖一次 10 秒。
process.on("SIGTERM", () => {
  console.log("收到 SIGTERM，退出");
  process.exit(0);
});

serve({ fetch: app.fetch, port }, (info) => {
  const auth = token === "" ? "关" : "开";
  console.log(`brains 听着 ${info.port}（鉴权${auth}）`);
});
