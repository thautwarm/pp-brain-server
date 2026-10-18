/**
 * 把一段要念的文本切成"一次 TTS 请求"的粒度。
 *
 * 分句全部交给 wtpsplit-lite（compose 里的 `wtpsplit` 服务，**硬依赖**：切分失败这条回复就断流，
 * 不做本地兜底，也不在本地再切一遍）。它给的句子是原子，这里只做**装箱**（把相邻短句并到
 * 一次 TTS 请求里）：
 *
 *   ASCII 记 0.5，其余记 1，箱子上限 80
 *
 * 也就是"最多 80 个汉字 / 160 个英文字符"。之所以要装箱，是因为一句"嗯。"也单独发一次 TTS
 * 太浪费，而一句 200 字又会把首帧拖很久。
 */

/** 一次 TTS 请求的预算（权重单位：ASCII 0.5 / 其他 1）。 */
const CHUNK_WEIGHT = 80;

/**
 * **第一块**单独收紧：80 权重约 15 秒语音，合成要 3 秒多，首帧延迟全耗在这儿。第一块压到 32
 * 权重（约 6 秒语音）就能把"开口"提前两秒左右，后面再退回 80。
 */
const FIRST_CHUNK_WEIGHT = 32;

function weight(text: string): number {
  let total = 0;
  for (const ch of text) total += (ch.codePointAt(0) ?? 0) < 0x80 ? 0.5 : 1;
  return total;
}

/**
 * 调分句服务，返回装好箱的块。
 *
 * 端点由 `WTP_SPLIT_URL` 给（compose 内网地址），**没有兜底**：拿不到分句就抛，让这条流断掉
 * ——总比悄悄改成本地切分、行为和配置对不上好。
 */
/** 分句服务的超时。1024 字实测 ~90ms，5 秒已经很宽松；挂了不能把队列堵死。 */
const SPLIT_TIMEOUT_MS = 5_000;

export async function splitForTts(text: string, signal?: AbortSignal): Promise<string[]> {
  const url = process.env.WTP_SPLIT_URL;
  if (url === undefined || url === "") throw new Error("WTP_SPLIT_URL 没配");

  const res = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ text }),
    signal: AbortSignal.any(
      signal === undefined
        ? [AbortSignal.timeout(SPLIT_TIMEOUT_MS)]
        : [signal, AbortSignal.timeout(SPLIT_TIMEOUT_MS)],
    ),
  });
  if (!res.ok) throw new Error(`分句服务返回 ${res.status}`);

  const { sentences } = (await res.json()) as { sentences: string[] };
  return pack(sentences);
}

/** 句子 trim 之后英文会粘成一个词（"Hello." + "World."），补一个空格；中文不加。 */
function joinSeparator(left: string, right: string): string {
  const last = left.codePointAt(left.length - 1) ?? 0;
  const first = right.codePointAt(0) ?? 0;
  return last < 0x80 && first < 0x80 ? " " : "";
}

/** 把句子装箱到 `cap` 权重以内；第一块用更小的 `firstCap`（见 `FIRST_CHUNK_WEIGHT`）。 */
export function pack(
  sentences: readonly string[],
  cap = CHUNK_WEIGHT,
  firstCap = FIRST_CHUNK_WEIGHT,
): string[] {
  const out: string[] = [];
  let cur = "";
  let limit = firstCap;

  for (const sentence of sentences) {
    const piece = sentence.trim();
    if (piece === "") continue;

    // 一句话就超预算也照发——分句是 wtpsplit 的事，本地不再切。
    const sep = cur === "" ? "" : joinSeparator(cur, piece);
    if (cur !== "" && weight(cur) + weight(sep) + weight(piece) > limit) {
      out.push(cur);
      cur = piece;
      limit = cap;
      continue;
    }
    cur += sep + piece;
  }
  if (cur !== "") out.push(cur);

  return out;
}
