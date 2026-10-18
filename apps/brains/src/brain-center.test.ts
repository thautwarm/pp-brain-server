import assert from "node:assert/strict";
import { test } from "node:test";

import { Brains, evictIdleBrains } from "./brain-center.ts";

/**
 * 只测这次改动引入的**新行为**：任意 `brain_id` 现建、空闲 2 小时淘汰。
 *
 * 触碰用 `AbortSignal.timeout(50)` 收尾，别让测试真挂 25 秒。store 是模块级的，所以断言用
 * "包含"而不是全等。
 */
async function touch(brainId: string): Promise<void> {
  for await (const _chunk of Brains.brainToHuman(
    { brain_id: brainId },
    { signal: AbortSignal.timeout(50), waitMs: 50 },
  )) {
    // 刚建的 brain 不可能有内容，循环体走不到。
  }
}

test("brain_id 没有白名单：第一次出现就现建（等不到内容也不报错）", async () => {
  await assert.doesNotReject(touch("测试-现建"));
});

test("空闲淘汰：刚碰过的不动，超过 2 小时的才卸载", async () => {
  await touch("测试-淘汰");

  // 刚碰过 → 一个都不该被淘汰
  assert.deepEqual(evictIdleBrains(Date.now()), []);

  // 往后拨 2 小时多一点 → 至少这个名字在里面
  const evicted = evictIdleBrains(Date.now() + 2 * 60 * 60 * 1000 + 1000);
  assert.ok(evicted.includes("测试-淘汰"), `应当被淘汰，实际 ${JSON.stringify(evicted)}`);
});
