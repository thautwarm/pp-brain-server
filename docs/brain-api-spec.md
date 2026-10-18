# Brain API 规格

本文是 Brain API 的完整接口契约，供客户端（人类侧）与 agent 侧实现使用，不依赖其他文档。

服务提供四个端点、一组固定字段名、一套正文内文本约定。所有状态按 `brain_id` 隔离，并由服务端持有。

---

## 1. 传输

| 项 | 约定 |
| --- | --- |
| 方法 | 四个端点一律 `POST` |
| 路径 | 见 §3，无查询参数 |
| 鉴权 | `Authorization: Bearer <token>`，四个端点都要求 |
| 请求体编码 | `application/msgpack` 或 `application/json`，各端点支持范围见 §2 |
| 成功响应编码 | 与请求体编码相同（见 §2）；`/brain-to-human` 例外，固定 `application/octet-stream` |
| 失败响应 | 非 2xx + `Content-Type: text/plain`，正文为一句人类可读的原因 |
| 音色 | 可选请求头 `x-brain-voice`（旧名 `x-might-voice` 也认），两个提交端点都接受，只有 §3.3 影响合成 |

状态码（各端点通用）：

| 码 | 含义 |
| --- | --- |
| `200` | 成功 |
| `400` | 请求体形状或编码不合法 |
| `401` | 鉴权失败 |
| `500` | 服务端内部失败 |
| `502` | 上游失败（转写 / 合成），见 §3.1、§3.2 |

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
| `POST /brain-to-human` | brain → 人类 | 长轮询，前导 + Ogg 流 | 仅 MessagePack | `application/octet-stream`（§3.2） |
| `POST /agent-to-brain` | agent → brain | 提交，立即返回 | MessagePack / JSON | 同请求编码 |
| `POST /brain-to-agent` | brain → agent | 长轮询 | MessagePack / JSON | 同请求编码 |

编码判定：

- `human-to-brain`、`brain-to-human`：只按 MessagePack 解析请求体，`Content-Type` 不参与判定。解析失败返回 `400`。
- `human-to-brain` 的响应是 MessagePack；`brain-to-human` 的响应是"前导 + Ogg 流"（§3.2）。
- `agent-to-brain`、`brain-to-agent`：`Content-Type` 为 `application/json` 时按 JSON 解析，其余（含缺省）按 MessagePack 解析。响应使用同一编码。

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

长轮询，取 brain 对人类的回复。**响应体是「前导 + 一段 Ogg Opus 流」**。

请求（MessagePack）：

```ts
{ brain_id: string, skip_before?: number }
```

响应 200（`Content-Type: application/octet-stream`）：

```
[u32 大端 文本长度][UTF-8 文本][1 字节 flags][Ogg Opus 流…]
```

- `文本长度 = 0`：这一轮没有内容。后面既没有文本也没有音频，客户端立刻重发。
- `flags` 只有 bit0 有定义：`1` = 这条是 `skip_before` 跳过的旧消息，**body 里没有音频**；其余位保留，
  必须为 0。
- 文本是这条回复的**原始**文本（`<!-- disable voice -->` 段原样保留，那些段只是不产生音频）。
- 音频是**一条连续的 Ogg Opus 流**（采样率见 §6），直接喂解码器，不要按块拼。
- **没有结束标记**：body 正常结束 = 说完了。TTS 中途挂掉也是 body 结束，客户端不区分二者
  （想区分只能靠 Ogg EOS：正常结束一定有 EOS page）。
- 等不到内容时挂到长轮询上限（§8），然后回 `文本长度 = 0`。
- 客户端断开，服务端立即停掉合成；已经取走的这条消息不会重投（§7）。
- `skip_before`（可选，UTC epoch **毫秒**，客户端的钟）：早于这个时刻入队的 agent 消息不合成，
  只回文本并把 `flags` 的 bit0 置 1。**一条响应最多一条消息**，客户端重发来逐条排空。
- 出声之前就失败（音色不存在、TTS 连不上、返回的不是 Ogg）→ `502`，这条消息放回队列，
  下一次轮询还能拿到。

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
- 整段均处于禁用状态时，该条不产生语音：§3.2 的响应只有前导和文本，没有音频。

---

## 6. 音频

| 方向 | 端点字段 | 编码 | 采样率 |
| --- | --- | --- | --- |
| 上行 | `/human-to-brain` 请求的 `audio` | Ogg Opus | 16 kHz |
| 下行 | `/brain-to-human` 响应 body（前导之后） | Ogg Opus 流 | **不保证**（见下） |

- 上行音频在 MessagePack 里是 bin 类型（不是 base64）；下行是响应 body 里的连续字节流，不经过 MessagePack。
- **服务端不保证、也不承诺下行的采样率。** 下行音频由 TTS 端点产出，服务端原样透传、不做重采样；
  它只是"碰巧"通常是 24 kHz。客户端不得依赖这个值。
- Opus 内部恒为 48 kHz；Ogg Opus 头里的采样率只是提示信息。客户端解码器（如 Android 的
  `MediaCodec`）通常直接输出 48 kHz。**客户端必须读解码器实际输出的采样率再据此重采样，不得写死。**

---

## 7. 投递语义

- `/brain-to-human` 与 `/brain-to-agent` 为长轮询。"没有内容"的表示：前者是 `文本长度 = 0`，后者是
  `{ "kind": "empty" }`。客户端收到就应立即重新发起请求，不得等待或退避。
- 消息**读即消费**：服务端取出后即从队列移除，无确认、无重投。响应未能送达客户端（连接中断等）即视为该条丢失。
- 回复中断时同理：已经发出的字节算送达，未发出的部分不会重投。
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
| `/brain-to-human` | 25 s | **只约束等到有内容**；开始出声后可以挂到说完（§3.2） |

上述值为服务端默认，可配置。客户端应把长轮询上限视为"服务端可能长时间不返回"，并按 §7 处理"没有内容"。
