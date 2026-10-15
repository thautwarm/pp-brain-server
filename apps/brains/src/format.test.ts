import assert from "node:assert/strict";
import { test } from "node:test";

import { Format } from "./format.ts";

/**
 * 这些字符串**会进 agent 的 prompt**，agent 那边可能按字面认它们，所以逐字钉住——
 * 改一个字符就该有人停下来想想是不是有意的。
 */
test("Format：进 prompt 的标签逐字钉住", () => {
  assert.equal(
    Format.unheardText("没听完的那半句"),
    '<unheard_text reason="用户打断讲话">没听完的那半句</unheard_text>',
  );
  // 多行：内容两侧各留一个换行、内容 trim 掉 —— 跟这一家其他标签一致
  assert.equal(
    Format.unheardText("第一句\n  第二句  "),
    '<unheard_text reason="用户打断讲话">\n第一句\n  第二句\n</unheard_text>',
  );
  assert.equal(Format.asrToAgentReply("你好"), "<asr-recognized-text>你好</asr-recognized-text>");
  assert.equal(Format.claimAgentResponse("好的"), "<agent-response>好的</agent-response>");
});
