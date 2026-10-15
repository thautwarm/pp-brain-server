import assert from "node:assert/strict";
import { test } from "node:test";

import type { Brain } from "./brain-center.ts";
import { audioTailIndices } from "./revise.ts";

const audio = (): Brain["history"][number] => ({ kind: "human-audio", audioB64: "x" });
const text = (): Brain["history"][number] => ({ kind: "human-audio-transcript", text: "x" });

const sorted = (set: Set<number>) => [...set].sort((a, b) => a - b);

test("audioTailIndices：只取尾部最多 max 条音频的下标", () => {
  //           0        1       2        3       4       5       6       7
  const h = [audio(), text(), audio(), text(), audio(), audio(), text(), audio()];

  // 一共 5 条音频（0/2/4/5/7），没到 7 → 全带
  assert.deepEqual(sorted(audioTailIndices(h, 7)), [0, 2, 4, 5, 7]);
  // 只要尾部 2 条音频 → 落在下标 5、7（不是下标相邻的两个）
  assert.deepEqual(sorted(audioTailIndices(h, 2)), [5, 7]);
  // 只要 1 条
  assert.deepEqual(sorted(audioTailIndices(h, 1)), [7]);
  // 一条音频都没有
  assert.deepEqual(sorted(audioTailIndices([text(), text()], 7)), []);
  // 空历史
  assert.deepEqual(sorted(audioTailIndices([], 7)), []);
  // max 为 0（关掉音频）
  assert.deepEqual(sorted(audioTailIndices(h, 0)), []);
});
