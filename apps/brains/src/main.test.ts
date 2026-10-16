import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { test } from "node:test";

const MAIN = path.resolve(import.meta.dirname, "main.ts");

/**
 * 起一个 main.ts 看它怎么退出。
 *
 * 只跑**会退出**的那两条路：配置齐全时它会 serve 起来一直挂着，那种验证得手动
 * （见 docs/brains.md 的「验证」）。
 */
function run(env: Record<string, string>): { status: number | null; stderr: string } {
  const result = spawnSync(process.execPath, [MAIN], { env, encoding: "utf8" });
  return { status: result.status, stderr: result.stderr };
}

test("main：什么都没配就点名缺哪个变量，退出码非 0", () => {
  const { status, stderr } = run({});

  assert.notEqual(status, 0);
  assert.match(stderr, /缺少环境变量 STT_API_BASE_URL/);
});

test("main：env 齐了但 config.toml 读不到，也带着路径说清楚", () => {
  const { status, stderr } = run({
    STT_API_BASE_URL: "http://stt.invalid/v1",
    TTS_API_BASE_URL: "http://tts.invalid/v1",
    MIGHT_CHAT_API_KEY: "k",
    MIGHT_CHAT_API_BASE_URL: "http://chat.invalid/v1",
    MIGHT_BRAINS_CONFIG: "/nonexistent/brains-config.toml",
  });

  assert.notEqual(status, 0);
  assert.match(stderr, /brains-config\.toml/);
});
