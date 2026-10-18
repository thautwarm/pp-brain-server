import assert from "node:assert/strict";
import { test } from "node:test";

import { pack, splitForTts } from "./split.ts";

/**
 * 只测装箱规则（纯函数）。`splitForTts` 的分句部分要真的 wtpsplit 服务，留给 compose 起来后的
 * 手工验证（见 docs/brains.md 的「验证」）。
 */

test("pack：短句并成一块，不是一句一次 TTS", () => {
  assert.deepEqual(pack(["你好。", "今天天气不错。"]), [
    { text: "你好。今天天气不错。", sentences: 2 },
  ]);
});

test("pack：短句装箱到 80 权重以内，第一块只装 32", () => {
  const chunks = pack(Array.from({ length: 20 }, () => "第一段很长。"));
  assert.ok(chunks.length >= 2);
  assert.ok([...chunks[0]!.text].length <= 32, `首块超了：${chunks[0]?.text.length}`);
  for (const chunk of chunks.slice(1)) assert.ok([...chunk.text].length <= 80);
  // 句子数加起来等于输入的句子数
  assert.equal(
    chunks.reduce((sum, chunk) => sum + chunk.sentences, 0),
    20,
  );
});

test("pack：ASCII 记 0.5，所以 150 个字母算 75 权重", () => {
  assert.deepEqual(pack(["a".repeat(150)], 80, 80), [{ text: "a".repeat(150), sentences: 1 }]);
});

test("pack：英文句子之间补空格，不粘成一个词", () => {
  assert.deepEqual(pack(["Hello. ", "World."], 80, 80), [{ text: "Hello. World.", sentences: 2 }]);
});

test("pack：单句本身超预算也不本地切（分句是 wtpsplit 的事）", () => {
  const long = "一".repeat(200);
  assert.deepEqual(pack([long], 80, 80), [{ text: long, sentences: 1 }]);
});

test("splitForTts：没有 WTP_SPLIT_URL 就直接抛（硬依赖，不做本地兜底）", async () => {
  await assert.rejects(splitForTts("你好。"), /WTP_SPLIT_URL/);
});
