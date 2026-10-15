/** 静音标记：这一段**不念**（见 `Format.forTts`）。 */
const VOICE_OFF = "<!-- disable voice -->";
const VOICE_ON = "<!-- enable voice -->";

export const Format = {
  asrToAgentReply(recognized: string) {
    if (recognized.includes("\n") || recognized.includes("\r")) {
      return "<asr-recognized-text>\n" + recognized.trim() + "\n</asr-recognized-text>";
    }
    return "<asr-recognized-text>" + recognized + "</asr-recognized-text>";
  },

  claimAgentResponse(response: string) {
    if (response.includes("\n") || response.includes("\r")) {
      return "<agent-response>\n" + response.trim() + "\n</agent-response>";
    }
    return "<agent-response>" + response + "</agent-response>";
  },

  warning(message: string) {
    if (message.includes("\n") || message.includes("\r")) {
      return "<asr-warning>\n" + message.trim() + "\n</asr-warning>";
    }
    return "<asr-warning>" + message + "</asr-warning>";
  },

  systemNotification(message: string) {
    if (message.includes("\n") || message.includes("\r")) {
      return "<system-notification>\n" + message.trim() + "\n</system-notification>";
    }
    return "<system-notification>" + message + "</system-notification>";
  },

  /**
   * 人类**没听到**的那段：打断时 agent 已经说出来、但没播完的话。
   *
   * 注意语义 —— 它裹的**不是**人类说的话，是 agent 自己说过、人类没听到的话，所以别把它
   * 和 `<asr-recognized-text>` 混成一类。放进给 agent 的文本前面用（见 brain-center）。
   *
   * 多行按这一家的老规矩：内容两侧各留一个换行、内容 trim 掉，让标签自己占一行。
   *
   * 名字和 reason 都是临时的（reason 目前写死"用户打断讲话"）。
   */
  unheardText(unheard: string) {
    if (unheard.includes("\n") || unheard.includes("\r")) {
      return `<unheard_text reason="用户打断讲话">\n${unheard.trim()}\n</unheard_text>`;
    }
    return `<unheard_text reason="用户打断讲话">${unheard}</unheard_text>`;
  },

  /**
   * 取出**该念出来的**那部分：`<!-- disable voice -->` 到 `<!-- enable voice -->` 之间的
   * 内容（连标记一起）全去掉。一段里可以有多组。
   *
   * 只影响"念"——文本本身照旧保留（人还看得到，history 也照旧）。所以调用点要**同时**留着
   * 原文和这个结果，别把原文换掉。
   *
   * 标记不成对时不猜，按"宁可不念"处理：开着的 disable 一直没等到 enable，剩下的就都不念；
   * 落单的 enable 当成普通标记丢掉（它出现那会儿本来也没在静音）。
   */
  forTts(text: string) {
    let spoken = "";
    let muted = false;
    let rest = text;

    for (;;) {
      const off = rest.indexOf(VOICE_OFF);
      const on = rest.indexOf(VOICE_ON);
      const cut = off === -1 ? on : on === -1 ? off : Math.min(off, on);
      if (cut === -1) break;

      if (!muted) spoken += rest.slice(0, cut);
      muted = cut === off;
      rest = rest.slice(cut + (muted ? VOICE_OFF : VOICE_ON).length);
    }

    return muted ? spoken : spoken + rest;
  },

  /**
   * 这段文本该用什么语言念：**全是 ASCII 就当英文**，否则不指定（交给服务端默认）。
   *
   * 只看"字符集"这一个判据是有意的 —— 需要它的场景只有一个：要不要按中文念。中日韩全在
   * ASCII 之外，所以"有没有非 ASCII 字符"就是这个问题最短的答案，不用做语种识别。
   *
   * 副作用：带重音的拉丁字母（café）也会落到默认。那种情况少见，不值得为它加规则。
   */
  ttsLanguage(text: string): "en" | undefined {
    return /^[\x00-\x7f]*$/.test(text) ? "en" : undefined;
  },
};

export class SizedQueueOps {
  static push<T>(arr: T[], item: T, size: number) {
    if (arr.length >= size) {
      arr.shift();
    }
    arr.push(item);
  }

  static removeByIdentity<T>(arr: T[], item: T) {
    const index = arr.findIndex((x) => x === item);
    if (index !== -1) {
      arr.splice(index, 1);
    }
  }
}
