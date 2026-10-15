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

import { Brains, registerBrains, startBackgroundTask } from "./brain-center.ts";
import { loadBrainConfig } from "./config.ts";
import { createBrainRouter } from "./http.ts";

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

// config.toml 是访问名单：里面的名字就是全部可用的 brain（见 config.ts）。
const configPath = process.env.MIGHT_BRAINS_CONFIG ?? "config.toml";
const configured = await loadBrainConfig(configPath).catch((cause: unknown) =>
  die(cause instanceof Error ? cause.message : String(cause)),
);
registerBrains(configured);

const token = process.env.MIGHT_BRAINS_TOKEN ?? ""; // 空 = 不启用鉴权（规格 §0.2）
const port = envInt("MIGHT_BRAINS_PORT", 8787);

const app = createBrainRouter({
  ports: Brains,
  token,
  pollTimeoutMs: envInt("MIGHT_BRAINS_POLL_TIMEOUT_MS", 25000),
});

// 修订和 TTS 都跑在这里面。它每步自己吞异常，所以不用 await，也不用管它的返回值。
startBackgroundTask();

// **容器里 node 就是 PID 1**，而内核不对 PID 1 施加"默认动作"信号——我们又没装 handler，
// 于是 SIGTERM 被直接丢掉，`docker stop` 只能等满默认的 10 秒 grace 再 SIGKILL
// （`docker compose stop` 实测 10.2 秒、退出码 137 就是这个）。
// 装个 handler 是这个问题最短的解法；`init: true` 也行（见 docker-compose.yaml）。
//
// 直接退出、不做 graceful drain：这个进程的状态全在内存里，重启本来就清零，没必要为了
// 让在途的长轮询（最长 25 秒）跑完而再拖一次 10 秒。
process.on("SIGTERM", () => {
  console.log("收到 SIGTERM，退出");
  process.exit(0);
});

serve({ fetch: app.fetch, port }, (info) => {
  const auth = token === "" ? "关" : "开";
  console.log(
    `brains 听着 ${info.port}（鉴权${auth}）：${configured.map((b) => b.id).join(" / ")}`,
  );
});
