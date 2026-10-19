# pp-brain-server

Self-hosted Brain API server for [PP Friend](https://github.com/thautwarm/pp-friend): the phone only records and plays audio — transcription, revision, and synthesis all run here; the agent side sees a plain text channel.

English | [中文](README.zh.md)

## Quick start

**Prerequisites**

- Docker with the Compose plugin.
- Three reachable upstreams (typically on your LAN):
  - an OpenAI-compatible STT endpoint serving `/audio/transcriptions`,
  - a streaming TTS endpoint serving `/audio/speech/stream`
    (the HTTP shape used by [moss-tts-windowed](https://github.com/thautwarm/moss-tts-windowed)),
  - an OpenAI-compatible chat endpoint for revision/summarization.

**Deploy**

```bash
git clone https://github.com/thautwarm/pp-brain-server.git && cd pp-brain-server
cp .env.example .env     # fill in endpoints, keys, model names — before starting
docker compose up -d --build
```

In `.env` you **must** set: `STT_API_BASE_URL`, `TTS_API_BASE_URL`, `TTS_VOICE`, `MIGHT_CHAT_API_KEY`, `MIGHT_CHAT_API_BASE_URL`. Any missing required variable aborts startup with a named error — the server never comes up half-configured.

> **An empty value is not the default.** The code reads `process.env.X ?? default`, so an empty string *overrides* the default. Optional entries are commented out in the template — leave them commented unless you mean to set them. Also, `.env` supports whole-line comments only: a trailing `#` becomes part of the value.

**Watch it come up**

```bash
docker compose logs -f brains
# expect: brains 听着 8787（鉴权关）
#   = "listening on 8787 (auth off)"; with a token set it says 鉴权开 (auth on)
```

**Verify** — there is no `/health` endpoint. Use any of:

```bash
docker compose ps                 # container might-brains-1 running
docker compose logs brains        # the listening line above

# A request expected to fail with 400 proves HTTP is listening
# (400 = bad body shape, missing brain_id). With a token set, add
# -H 'authorization: Bearer <token>' or you'll get 401 instead.
curl -sS -o /dev/null -w '%{http_code}\n' -X POST http://localhost:18781/brain-to-agent \
  -H 'content-type: application/json' -d '{}'
```

**Connect a client** — in PP Friend, set the server to `http://<host>:18781` (host port 18781 maps to container port 8787). `brain_id` is any non-empty string you pick — the server creates it on first sight, so a typo just starts a new conversation rather than erroring. If you set `MIGHT_BRAINS_TOKEN`, the client sends it as `Authorization: Bearer <token>`; if the token is empty, auth is off and no header is sent.

## Usage

Four endpoints, a 2×2 of who (human / agent) × direction (into / out of the brain). All are `POST`; names are mechanically `<from>-to-<to>`:

| Endpoint | Direction | Semantics | Request body |
| --- | --- | --- | --- |
| `POST /human-to-brain` | human → brain | Submit a speech clip (Ogg Opus 16 kHz mono), get the transcript back | MessagePack only |
| `POST /brain-to-human` | brain → human | Long-poll for speech to the human; response is **prelude + Ogg stream** | MessagePack only |
| `POST /agent-to-brain` | agent → brain | Submit a text, return immediately; the server synthesizes it | MessagePack or JSON |
| `POST /brain-to-agent` | brain → agent | Long-poll for text handed down to the agent | MessagePack or JSON |

**Two calling conventions.** The agent pair speaks JSON or MessagePack (the response mirrors the request's encoding — JSON in, JSON out). The human pair is **MessagePack only**: `/human-to-brain` carries binary audio, and MessagePack's bin type packs bytes and structured fields in one object, with no multipart and no base64; `/brain-to-human` follows the same convention even though its request is only a small map. `curl -d` / `-F` cannot produce MessagePack — encode the body with any msgpack library into a file first.

Minimal examples (placeholders: `<host>`, `<token>`, `<brain>`):

```bash
# agent → brain: push a text to be spoken (returns immediately)
curl -sS -X POST http://<host>:18781/agent-to-brain \
  -H 'authorization: Bearer <token>' \
  -H 'content-type: application/json' \
  -d '{"brain_id":"<brain>","text":"Hello from the agent."}'

# brain → agent: long-poll for what the human said (or revision warnings)
curl -sS -X POST http://<host>:18781/brain-to-agent \
  -H 'authorization: Bearer <token>' \
  -H 'content-type: application/json' \
  -d '{"brain_id":"<brain>"}'

# brain → human: long-poll for speech. Body must be pre-encoded MessagePack.
curl -sS -X POST http://<host>:18781/brain-to-human \
  -H 'authorization: Bearer <token>' \
  -H 'content-type: application/msgpack' --data-binary @request.msgpack -o frames.bin
```

**The `/brain-to-human` response** is `application/octet-stream`, laid out as:

```
[u32 big-endian text length][UTF-8 text][1 byte flags][Ogg Opus stream…]
```

The text arrives whole; the audio is one continuous stream — feed it straight to a decoder, don't reassemble chunks. `flags` bit0 means this is an old message skipped via `skip_before`: text only, no audio in the body. Text length 0 means "nothing this round" — resend the request immediately, don't back off. Do not parse the body as a single msgpack object; see `readSpeech` in `apps/brains/src/http.test.ts` for a reference reader.

**`skip_before`** (optional, UTC epoch **milliseconds**, on the client's clock): agent messages enqueued before this instant are not synthesized — they come back text-only with flags bit0 set, one per response, so the client can drain a backlog. Use it when the user dismisses queued speech.

**`unheard_text`** (optional field of `/human-to-brain`): when the human interrupts, the part of the agent's reply they never heard goes here; the server prepends it to that turn's transcript for the agent. Absent / `null` / empty all mean "nothing unheard".

**Voice override**: the optional header `x-brain-voice` (legacy name `x-might-voice` also accepted) sets the voice for that one message only, on `/agent-to-brain`; without it, the deployment's `TTS_VOICE` applies. In `text`, regions between `<!-- disable voice -->` and `<!-- enable voice -->` are shown but not spoken.

Full contract (the single authority): [docs/brain-api-spec.md](docs/brain-api-spec.md).

## Configuration

Everything lives in `.env` (template: `.env.example`), passed into the container via `env_file` — never baked into the image, never committed.

| Variable | Purpose |
| --- | --- |
| `STT_API_BASE_URL` / `STT_API_KEY` / `STT_MODEL` | Transcription endpoint (OpenAI-compatible; `/audio/transcriptions` is appended to the base URL). `STT_MODEL` defaults to `qwen-asr` |
| `TTS_API_BASE_URL` / `TTS_API_KEY` | Synthesis endpoint; `/audio/speech/stream` is appended (streaming TTS). `TTS_MODEL` is **no longer used** — model/voice are the daemon's business |
| `TTS_VOICE` | **Required.** Default voice; the name must be one your TTS daemon recognizes (`default` = no reference voice). A wrong value does not fail startup, but every synthesis returns 502 (reason in the logs) |
| `MIGHT_CHAT_API_KEY` / `MIGHT_CHAT_API_BASE_URL` | Chat endpoint for revision/summarization |
| `MIGHT_CHAT_MODEL` | Model name for revision |
| `MIGHT_BRAINS_TOKEN` | Route auth; empty = disabled |
| `MIGHT_BRAINS_PORT` | Listen port, default 8787 (the container port; compose publishes it as host 18781) |
| `MIGHT_BRAINS_POLL_TIMEOUT_MS` | Long-poll ceiling, default 25000; for `/brain-to-human` it only bounds waiting for content — once speech starts it may run to the end |
| `MIGHT_LOG_LLM` | Set to `1` to dump requests/responses to the chat model into `logs/revise/<date>/<uuid>/{request,response}.json`. **Contains full conversation content** — enable only while debugging |
| `MIGHT_LOG_LLM_DIR` | Log root, default `logs` (compose mounts `./logs` there) |

Reminders: required-but-missing variables abort startup with named errors; empty string ≠ default (see Quick start); long-poll clients should treat the timeout as "the server may legitimately hold the request" and reissue immediately on an empty result.

## Operations

```bash
docker compose logs -f brains     # all runtime signal is here
docker compose restart brains     # state is in-memory: restart wipes all conversations
```

**Log lines**

- `[agent] +1 <brain> <asr|warning> q=a→b "<first 60 chars>"` — enqueued; the same line carries `DROPPED-OLDEST` when the queue cap is hit.
- `[agent] -1 <brain> q=a→b "<first 60 chars>"` — dequeued; carries `ABORTED(…this one is lost)` if the client had disconnected.
- `[in] <brain> agent voice=… "…"` — agent pushed text in (with the voice used this time).
- `[tts] <brain> voice=… "…"` — voice and text actually handed to TTS; failures/skips/drops log in this family too.
- `[tts] <brain> 客户端 skip_before 跳过 "…"` — client sent `skip_before`; this message ships text-only.
- `[b2h] <brain> empty` / `speech N 字 M B T ms` / `客户端断开 M B` / `中断 M B` — outcome of each `/brain-to-human` and the bytes actually sent.
- `[llm] <uuid> <status> <elapsed>` — only with `MIGHT_LOG_LLM=1`; payloads under `logs/revise/<date>/<uuid>/`.
- `[brain] <brain> 第一次出现，已创建` / `空闲超过 2 小时，已卸载` — brain created on first sight / evicted after 2 h idle.

Reconciliation: **pushes = dequeues + items still queued**; if it doesn't add up, one of the two drop paths above fired.

**Limits and lifecycle**

- Queues cap at 64 per direction per brain; when full, the **oldest** message is dropped. Delivery is read-and-consume: no acks, no redelivery, one consumer per outbound queue (two pollers compete for messages — it is not broadcast).
- `brain_id`s are created on first sight and **evicted after 2 hours idle** (otherwise random names would eat memory). Everything is in-memory: a restart zeroes all history and queues.
- Upstream timeouts: transcription 13 s (then 502); long polls 25 s by default.

**Common failures**

| Symptom | Likely cause |
| --- | --- |
| Every synthesis 502s | `TTS_VOICE` names a voice the TTS daemon doesn't know. Startup won't catch this — the reason is in the `[tts]` log lines |
| 502 on `/human-to-brain` | STT upstream down or past the 13 s cap |
| 401 everywhere | Token mismatch; empty server-side token means auth off and clients must send no `Authorization` header |
| Port already in use | Change the left side of `ports:` in `docker-compose.yaml` (host side; keep the container side at 8787 unless you also set `MIGHT_BRAINS_PORT`) |
| Client gets "wrong conversation" | `brain_id` typo — there is no whitelist, a misspelling just opens a new conversation; also check the client sends a stable name (state evaporates after 2 h idle) |
| `docker compose stop` takes 10 s and exits 137 | In the container `node` is PID 1, and the kernel applies no default signal actions to PID 1. The SIGTERM handler in `main.ts` is load-bearing — don't remove it |

## How it works

- **All state in memory.** Each brain's history and queues live in the process; restart = clean slate. (The chat layer can already serialize sessions — persistence would be one more module.)
- **Full duplex.** The human side continuously long-polls for things to say while uploading speech on a parallel path. Interruptible: when the user starts talking, the client drops playback and hands the unheard remainder back via `unheard_text`.
- **Streaming synthesis.** Synthesis does not run in the background: each `/brain-to-human` request synthesizes and forwards chunk by chunk (`POST /audio/speech/stream`, relaying the `audio/ogg` body as-is — no sentence splitting, no resampling; a client disconnect aborts the upstream request). If nobody polls, nothing is synthesized.
- **Background revision.** A 35 ms tick loop drives two jobs: revision (every 3 dirty turns, an external chat model inspects recent transcripts — with at most the last 7 audio clips attached — and may raise `<asr-warning>` alerts to the agent; oversized turns also trigger history compression) and idle eviction (brains idle 2 h are unloaded, swept every 10 s).
- **Failure placement.** If TTS fails before the first byte (unknown voice, unreachable daemon), the poll returns 502 and the message goes back to the queue (up to 3 times); mid-stream failures just end the body, indistinguishable from a normal end except via the Ogg EOS page.

Details: [docs/brains.md](docs/brains.md) (runtime behavior, logs, pitfalls) and [docs/brain-api-spec.md](docs/brain-api-spec.md) (wire contract).

## Development

Node 24 runs the TypeScript directly — zero build, no `dist/`:

```bash
pnpm install
pnpm verify                                # check + lint + test
node --env-file=.env apps/brains/src/main.ts   # run without Docker
node apps/brains/src/main.ts               # with empty config: exits with a clear, named error
```

Code layout:

```
packages/chat/        @might/chat — session layer (UIMessage / ChatAgent) + credential→model adapters
packages/audio/       @might/audio — audio layer (synthesis / transcription / Ogg Opus)
apps/brains/          the Brain API server itself
  src/http.ts         routing, auth, validation, long polling, speech framing
  src/brain-center.ts queues, history, chunked synthesis, logging
```

Read [DEVDOCS.md](DEVDOCS.md) before changing anything in this repo.

## Docs

- [docs/brain-api-spec.md](docs/brain-api-spec.md) — the interface contract (single authority)
- [docs/brains.md](docs/brains.md) — running the server: configuration, runtime behavior, logs, sharp edges
- [docs/client-notes.md](docs/client-notes.md) — client (phone-side) implementation notes
- [DEVDOCS.md](DEVDOCS.md) — how this repo is put together and why
- [`site/`](site/) — static site source (`index.html` + `brain-api/`); not yet published (GitHub Pages requires a public repo)
