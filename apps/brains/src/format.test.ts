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

test("Format.forTts：只影响念，标记和段内内容全去掉", () => {
  const OFF = "<!-- disable voice -->";
  const ON = "<!-- enable voice -->";

  // 没有标记：原样
  assert.equal(Format.forTts("你好呀"), "你好呀");

  // 一组：段内和两个标记都没了
  assert.equal(Format.forTts(`说这句。${OFF}这句不念${ON}再说这句。`), "说这句。再说这句。");

  // 多组：全都去掉
  assert.equal(Format.forTts(`A${OFF}b${ON}C${OFF}d${ON}D`), "ACD");

  // 开着的 disable 没等到 enable：剩下都不念（宁可不念）
  assert.equal(Format.forTts(`留下的${OFF}后面全不要`), "留下的");

  // 落单的 enable：标记丢掉，内容照旧念
  assert.equal(Format.forTts(`${ON}你好`), "你好");

  // 整段都被静音 → 空（调用点据此跳过合成）
  assert.equal(Format.forTts(`${OFF}整段${ON}`).trim(), "");
});
