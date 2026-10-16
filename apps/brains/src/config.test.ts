import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";

import { loadBrainConfig } from "./config.ts";

/** 把内容写成一份临时 config.toml，返回路径。 */
async function writeConfig(text: string): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), "brains-config-"));
  const file = path.join(dir, "config.toml");
  await writeFile(file, text, "utf8");
  return file;
}

test("config：一个 brain 一张表，键就是 brain_id", async () => {
  const file = await writeConfig(`
# 注释和空行该被吃掉
[example-a]
voice = "voice-a"

# brain_id 是中文就得加引号：TOML 的裸键只认 A-Za-z0-9_-
["员工3"]
voice = "voice-b"
`);

  assert.deepEqual(await loadBrainConfig(file), [
    { id: "example-a", voice: "voice-a" },
    { id: "员工3", voice: "voice-b" },
  ]);
});

test("config：坏了要说清楚是哪个文件、哪一条", async () => {
  // 缺 voice
  const missingVoice = await writeConfig("[example-a]\n");
  await assert.rejects(() => loadBrainConfig(missingVoice), /example-a.*voice/);

  // 不是合法 TOML（少了右括号、字符串没闭合）
  const broken = await writeConfig("[example-a\nvoice = ");
  await assert.rejects(() => loadBrainConfig(broken), /不是合法的 TOML/);

  // 中文 brain_id 忘了加引号：TOML 的裸键只认 A-Za-z0-9_-，这条最容易踩
  const bareChinese = await writeConfig('[员工3]\nvoice = "voice-b"\n');
  await assert.rejects(() => loadBrainConfig(bareChinese), /不是合法的 TOML/);

  // 一个 brain 都没有 —— 没有它服务起来也是空转，所以启动时就该拦下
  const empty = await writeConfig("# 什么都没有\n");
  await assert.rejects(() => loadBrainConfig(empty), /一个 brain 都没有/);

  // 文件根本不在：原样把 fs 的错误抛出去（主程序负责带路径报出来）
  await assert.rejects(() => loadBrainConfig("/nonexistent/brains-config.toml"), /ENOENT/);
});
