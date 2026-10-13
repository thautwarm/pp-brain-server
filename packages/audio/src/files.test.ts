/**
 * AudioHelper 里读写文件那两个。**只在 Node 里能用**（`node:fs` 是动态加载的），
 * 所以测试也在真实文件系统上跑，只是把根放在临时目录里，不往仓库里落东西。
 */
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";

import { AudioHelper } from "./index.ts";

const root = await mkdtemp(join(tmpdir(), "might-audio-"));
after(() => rm(root, { recursive: true, force: true }));

test("存了能读回来；目录不存在会顺手建出来", async () => {
  const bytes = Buffer.from("假装这是一段音频");
  const path = join(root, "a", "b", "x.ogg"); // a/ 和 b/ 都不存在
  await AudioHelper.saveAudioFile(bytes, path);

  assert.equal(Buffer.from(await AudioHelper.loadAudioFile(path)).toString(), bytes.toString());
});

test("speech.audio 那种对象也能直接存", async () => {
  // 结构上只要有 uint8Array 就行，不 import AI SDK 的类型也能用。
  const bytes = Buffer.from([1, 2, 3, 4]);
  const path = join(root, "wrapped.ogg");
  await AudioHelper.saveAudioFile({ uint8Array: bytes }, path);

  assert.deepEqual(await AudioHelper.loadAudioFile(path), bytes);
});

test("读不存在的文件：文件系统的错误原样抛，不包成 AudioError", async () => {
  // AudioError 是模型和转码的异常类型；文件的事就用文件的话说（ENOENT），调用方好分辨。
  await assert.rejects(AudioHelper.loadAudioFile(join(root, "没有这个.ogg")), (error: unknown) => {
    assert.equal((error as { code?: string }).code, "ENOENT");
    return true;
  });
});
