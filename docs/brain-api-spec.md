# Brain API 规格

本文是 Brain API 的完整接口契约，供客户端（人类侧）与 agent 侧实现使用，不依赖其他文档。

服务提供四个端点、一组固定字段名、一套正文内文本约定。所有状态按 `brain_id` 隔离，并由服务端持有。

---

## 1. 传输

| 项 | 约定 |
| --- | --- |
| 方法 | 四个端点一律 `POST` |
| 路径 | 见 §3，无查询参数 |
| 鉴权 | `Authorization: Bearer <token>`，四个端点都要求（流式同理） |
| 请求体编码 | `application/msgpack` 或 `application/json`，各端点支持范围见 §2 |
| 成功响应编码 | 与请求体编码相同（见 §2） |
| 失败响应 | 非 2xx + `Content-Type: text/plain`，正文为一句人类可读的原因 |
| 音色 | 可选请求头 `x-brain-voice`（旧名 `x-might-voice` 也认），两个提交端点都接受，只有 §3.3 影响合成 |

状态码（各端点通用）：

| 码 | 含义 |
| --- | --- |
| `200` | 成功 |
| `400` | 请求体形状或编码不合法 |
| `401` | 鉴权失败 |
| `500` | 服务端内部失败 |
| `502` | 上游失败（转写 / 分句 / 合成），见 §3.1、§3.2 |

约定：

- 鉴权 token 由服务端配置。**服务端 token 为空字符串时表示不启用鉴权**，此时客户端不发送 `Authorization` 头。
- 请求体中的未知字段一律忽略（不报错）；字段名拼错会因缺必填字段而得到 `400`。
- 成功响应的 `Content-Type` 绝不为 `text/plain`。客户端的成功/失败判据只有这一条。
- 请求体必须是对象（map / object），不是数组或标量。

---

## 2. 端点总览

| 端点 | 方向 | 语义 | 请求体编码 | 响应体编码 |
| --- | --- | --- | --- | --- |
| `POST /human-to-brain` | 人类 → brain | 提交，等待转写 | 仅 MessagePack | MessagePack |
| `POST /brain-to-human` | brain → 人类 | 长轮询，分帧流 | 仅 MessagePack | MessagePack 帧流（§3.2） |
| `POST /agent-to-brain` | agent → brain | 提交，立即返回 | MessagePack / JSON | 同请求编码 |
| `POST /brain-to-agent` | brain → agent | 长轮询 | MessagePack / JSON | 同请求编码 |

编码判定：

- `human-to-brain`、`brain-to-human`：只按 MessagePack 解析请求体，`Content-Type` 不参与判定。解析失败返回 `400`。响应恒为 MessagePack。
- `agent-to-brain`、`brain-to-agent`：`Content-Type` 为 `application/json` 时按 JSON 解析，其余（含缺省）按 MessagePack 解析。响应使用同一编码。
- `brain-to-human` 的响应恒为 MessagePack **帧流**（§3.2），没有"单个对象"的形态。

---

## 3. 端点

### 3.1 `POST /human-to-brain`

提交一段人类语音，返回转写文本。

请求（MessagePack）：

```ts
{
  brain_id: string,               // 必填，非空
  audio: Uint8Array,              // 必填，非空；Ogg Opus 16 kHz 单声道
  unheard_text?: string | null,   // 可选，见 §5.3
}
```

响应（MessagePack）：

```ts
{ kind: "text", text: string }
```

`x-brain-voice`（可选，旧名 `x-might-voice`）：服务端会收下并交给 brain 层，但本端点不合成语音，
所以目前不影响任何行为。音色是 per-request 的，见 §3.3。

服务端行为：

- 阻塞至转写完成，超时见 §8。
- 返回的 `text` 为转写结果；该结果的文本形态同时进入 §3.4 的 agent 流。

状态码：通用集见 §1，另加 `502`（转写上游失败或超时）。

---

### 3.2 `POST /brain-to-human`

长轮询，取 brain 对人类的回复。**响应是分帧流**：一条回复拆成若干帧，合成出一段就吐一段。

请求（MessagePack）：

```ts
{ brain_id: string, skip_before?: number }
```

响应（MessagePack **帧流**）：

```
[u32 大端长度][MessagePack]   ← 一帧，重复 N 次
```

每帧：

```ts
{ kind: "text", text: string, sentences: string[], skipped: boolean }           // 每条消息的第一帧
{ kind: "text", text: string, audio: Uint8Array, consumed_sentences: number }   // 音频帧
{ kind: "failed", consumed_sentences: number }                                  // 合成中途失败
{ kind: "empty" }                                                               // 等到超时、没有内容
```

- 第一帧**不带音频**：`text` 是这条回复的**原始文本**（`<!-- disable voice -->` 段照原样保留，那些
  段不合成语音），`sentences` 是 wtpsplit 切出来的句子表（它的 join 不一定等于 `text`）。客户端可以
  先上屏、拿到句子表，再等音频。`skipped: true` 的帧里 `sentences` 是**空数组**（服务端不为跳过的
  消息调分句）。
- 之后每帧是"一块文本 + 它的音频"：`text` 是**这一块**念的文本（不用于展示，用于算跳过/没听到），
  `consumed_sentences` 是**累计**已消费的句子数。客户端被打断时靠它算还差多少句没听到。
- `skipped: true`：这条是客户端用 `skip_before` 跳过的旧消息，只有这一帧，没有音频（见下）。
- `failed`：合成挂了，这条到此为止。客户端拿 `consumed_sentences` 和首帧的 `sentences` 比，
  就知道差了多少句。**正常说完不会有这一帧**（body 干净结束）。不想专门处理这一帧的客户端也可以
  直接用 `consumed_sentences < sentences.length` 判断，两条信息始终一致。
  - 任何一块都可能失败，**包括第一块**：那时 `consumed_sentences` 是 `0`，客户端只收到文本帧，
    一个音频帧都没有。
  - 分句失败不会走到这里（还没发任何帧，直接 `502`）；客户端自己断开也不会发（那是正常行为）。
  - 区分三种"没有音频帧"：`sentences` 非空 + `failed` = 合成挂了；`sentences` 为空 = 整条被
    `<!-- disable voice -->` 静音（合法）；`failed` 且 `sentences` 非空但 `consumed_sentences > 0`
    = 播到一半断的。
- 整条都被静音时只有第一帧，没有音频帧。
- `audio` 是 Ogg Opus（采样率见 §6），**每帧是一个独立的文件**：按帧解码，把 PCM 追加到播放队列，
  不要字节拼接。
- 超时（§8）只约束**等第一帧**；开始吐帧之后，这条连接可以一直挂到说完。
- **没有 `final` 字段**：body 正常结束 = 说完了。读不到完整的一帧（连接中断、长度越界）= 截断，
  客户端重新发起请求即可。
- 无内容时挂到长轮询上限，然后发一帧 `empty`；客户端收到就立刻重发。
- 客户端断开，服务端立即停止后续合成；已经取走的这条消息不会重投（§7）。
- `skip_before`（可选，UTC epoch **毫秒**，客户端的钟）：早于这个时刻入队的 agent 消息**不合成、
  不丢弃**，而是以 `skipped: true` 的文本帧原样回给客户端，由它自己处理（显示、或记进下一次的
  `unheard_text`）。处理完这些，接着返回真正要说的那条。
- **一条响应里最多一条 skipped 帧**，发完就结束 body；真正的回复永远单独占一条响应。客户端读完
  这一帧后重发请求，直到拿到的不是 skipped（旧消息通常只有几条，多一两次往返）。
- 只有跳过的消息、队列已经空了：body 直接结束，**不补 `empty` 帧**；客户端立刻重发即可。
- **断开时机**：第一帧发出去之前断开（还在分句），这条不算消费，下次轮询还会拿到；第一帧之后断开，
  算已送达，不再重投（客户端已经有全文，剩下的音频本来就接不上）。

怎么切块不在协议里：客户端只该假设"第一帧的文本是整条回复，音频按序拼起来就是整条语音"。

---

### 3.3 `POST /agent-to-brain`

agent 提交一段文本。该文本会被合成语音并经 §3.2 交付给人类。

请求（MessagePack 或 JSON）：

```ts
{ brain_id: string, text: string }   // text 必填，非空
```

响应（同请求编码）：

```ts
{ kind: "empty" }
```

服务端行为：

- 立即返回，不等待合成。
- `text` 允许包含 §5.4 的静音标记。

`x-brain-voice`（可选，旧名 `x-might-voice`）：**只作用于这一条消息**的语音。不带就用部署方配的默认音色。
brain 上不存音色，所以它不会影响这条以外的任何消息。

状态码：见 §1。

---

### 3.4 `POST /brain-to-agent`

长轮询，取 brain 交付给 agent 的文本。

请求（MessagePack 或 JSON）：

```ts
{ brain_id: string }
```

响应（同请求编码）：

```ts
{ kind: "empty" }
| { kind: "text", text: string }
```

`text` 的取值不是单一类型，见 §5。按产生来源分：

| 来源 | 正文形态 |
| --- | --- |
| 人类语音转写 | `<asr-recognized-text>…</asr-recognized-text>` |
| 人类打断时的补充 | `<unheard_text …>…</unheard_text>` 前置（见 §5.3） |
| 服务端校对告警 | `<asr-warning>…</asr-warning>` |

状态码：见 §1。

---

## 4. `brain_id`

- 由用户配置的字符串，客户端手输，形如 `"员工3"`、`"my-brain"`。
- **不要求预先登记。** 服务端第一次见到某个 `brain_id` 时创建它，所以没有"没有这个 brain"
  这条失败路径，也不存在 `404`；拼错名字的后果是**开了一段新对话**，不是报错。
- 所有会话状态（历史、队列）按 `brain_id` 隔离。
- **状态在内存里，且空闲 2 小时后被卸载。** 卸载或重启都等于那段对话没了。客户端要自己把
  `brain_id` 稳定住，并接受长期空闲后上下文丢失。
- 音色不在 body 里，走 `x-brain-voice`（见 §3.3）。

---

## 5. 正文内的文本约定

以下字符串属于接口契约，出现在 §3.4 的 `text` 或人类侧上下文里。标记为逐字匹配。

### 5.1 转写与回复

- `<asr-recognized-text>…</asr-recognized-text>`：人类语音的转写，交付给 agent。
- `<agent-response>…</agent-response>`：agent 提交的文本的回显形态。

多行内容时，标签内部两侧各有一个换行，内容两端空白被去除：

```
<asr-recognized-text>
第一行
第二行
</asr-recognized-text>
```

单行内容时标签紧贴内容，形如 `<asr-recognized-text>你好</asr-recognized-text>`。

### 5.2 校对告警

`<asr-warning>…</asr-warning>`：服务端对转写可能不准确的提醒，混在 §3.4 的流里交付给 agent。客户端无需解析。多行处理规则同 §5.1。

### 5.3 打断补充

`/human-to-brain` 的 `unheard_text` 为人类打断时未听到的内容（agent 已产生、人类未听完的部分）。该字段可空：缺省、`null`、空串均视为本次无内容。

非空时，服务端将其前置到该次转写之前，一并交付给 agent：

```
<unheard_text reason="用户打断讲话">
第一句没听完
第二句也没听完
</unheard_text>
<asr-recognized-text>帮我把客厅的灯关一下。</asr-recognized-text>
```

`reason` 取值当前固定为 `用户打断讲话`。多行处理规则同 §5.1。

### 5.4 语音禁用标记

`/agent-to-brain` 的 `text` 内可用下列标记划定**不合成语音**的区段：

```
第一句要念。<!-- disable voice -->此段不合成。<!-- enable voice -->第三句要念。
```

- 两个标记之间的内容（含标记本身）不进入语音合成；`text` 本身不受影响：人类侧仍显示完整文本。
- 一条 `text` 内可出现多组。
- 标记不成对时，开区间自标记处延续至文本末尾；单独的 `<!-- enable voice -->` 视为普通标记被移除。
- 整段均处于禁用状态时，该条内容不产生语音：§3.2 里只会有一帧 `{ kind: "text", text }`，没有 `audio`。

---

## 6. 音频

| 方向 | 端点字段 | 编码 | 采样率 |
| --- | --- | --- | --- |
| 上行 | `/human-to-brain` 请求的 `audio` | Ogg Opus | 16 kHz |
| 下行 | `/brain-to-human` 响应的 `audio` | Ogg Opus | **不保证**（见下） |

- 音频在 MessagePack 中为 bin 类型，非 base64。
- **服务端不保证、也不承诺下行的采样率。** 下行音频由 TTS 端点产出，服务端原样透传、不做重采样；
  它只是"碰巧"通常是 24 kHz。客户端不得依赖这个值。
- Opus 内部恒为 48 kHz；Ogg Opus 头里的采样率只是提示信息。客户端解码器（如 Android 的
  `MediaCodec`）通常直接输出 48 kHz。**客户端必须读解码器实际输出的采样率再据此重采样，不得写死。**

---

## 7. 投递语义

- `/brain-to-human` 与 `/brain-to-agent` 为长轮询。收到 `{ "kind": "empty" }` 表示当前无内容，客户端应立即重新发起请求，不得等待或退避。
- 消息**读即消费**：服务端取出后即从队列移除，无确认、无重投。响应未能送达客户端（连接中断等）即视为该条丢失。
- 回复中断时同理：已发出的帧算送达，未发出的部分不会重投。
- 服务端队列有上限（当前 `/brain-to-agent` 64 条、`/brain-to-human` 待合成的文本 64 条）。达到上限时丢弃**最旧**的一条。
- 每个 `brain_id` 的每个出向队列只应由**一个**消费者轮询。多个消费者是**竞争消费**——各自抢走
  一部分消息，**不是广播**。多台设备要听同一段对话，请用不同的 `brain_id`。
- 失败一律通过 HTTP 状态码表达。协议层不定义错误消息体，也不存在表示错误的 `kind`。客户端对网络错误的重试策略自负；`401` 不应重试。

---

## 8. 超时

| 项 | 当前值 | 说明 |
| --- | --- | --- |
| `/human-to-brain` | 13 s | 转写上限，超时返回 `502` |
| `/brain-to-agent` | 25 s | 长轮询上限，超时返回 `empty` |
| `/brain-to-human` | 25 s | **只约束等第一帧**；开始吐帧后可以挂到说完（§3.2） |

上述值为服务端默认，可配置。客户端应把长轮询上限视为"服务端可能长时间不返回"，并按 §7 处理 `empty`。
