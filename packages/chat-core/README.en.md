# @might/chat-core

English | [中文](./README.md)

The **fact layer** for a model conversation: application-side messages, tool calls, and one turn of
model progress.

- There is exactly one kind of conversation fact: `UIMessage`. Persistence, transport, and module
  contracts all use it.
- The AI SDK's provider-facing `ModelMessage` is projected only at the moment a request is made,
  then discarded.
- One turn = one `CoreAgent.request`: it advances one step and produces one assistant message.
  Whether to continue is up to the application.
- `CoreAgent` is a namespace, not something you instantiate. Everything under it is a stateless
  function — no instances, no configuration.

The upstream dependency is pinned to `ai@7.0.101`. Implementations live under `implementation/` and
mirror the public shape: members that hang directly off `Agent` are written in the implementation
`index`, while each sub-namespace gets its own file.

## Minimal usage (server)

```ts
import { CoreAgent } from "@might/chat-core";

const conversation = {
  messages: [
    { id: "m1", role: "user", parts: [{ type: "text", text: "hello" }] },
  ],
};

const run = CoreAgent.request({ conversation, model });

// Transport side: chunk stream → SSE response
return CoreAgent.chunks.toHttpResponse(run.chunks);

// Fact side: the one assistant message for this turn
const message = await run.result;
const next = CoreAgent.append(conversation, message);
```

`run.result` settles once the stream is consumed, so "stream it back" and "persist it" are two sides
of the same stream — you never read it twice.

## Over HTTP: `CoreAgent.chunks`

`CoreAgent.request` hands you a chunk stream that is not bound to any transport. Over HTTP, each
side converts once:

```ts
// server: encode the chunk stream as an SSE response
return CoreAgent.chunks.toHttpResponse(run.chunks);

// client: turn the response back into the same kind of chunk stream
const chunks = CoreAgent.chunks.fromHttpResponse(response);
```

Both sides use the same SSE encoding: the server writes `data: {...}\n\n` per chunk and ends with
`data: [DONE]`; the client parses each one against `uiMessageChunkSchema` and skips `[DONE]`. The
chunk sequence is unchanged after a round trip.

## Client: chunks in, messages out

```ts
for await (const message of CoreAgent.chunks.readMessages(chunkStream)) {
  render(message); // every yield is a full snapshot of the current message
}
```

The same message is yielded many times with a stable `id` and parts that grow towards completeness,
so you never reassemble deltas yourself. `chunkStream` is the `ReadableStream<UIMessageChunk>` you
got back from `CoreAgent.chunks.fromHttpResponse` above; the application side never sees chunks.

## Where the model and its parameters come from

The model instance, `generation`, and `providerOptions` are resolved by the caller and passed
through untouched:

```ts
const run = CoreAgent.request({
  conversation,
  model,
  generation,
  providerOptions,
  estimatePrice, // optional: run it once the usage is known
});
```

`estimatePrice` takes `usage` and its result is recorded in `metadata.estimatedPrice`. A failed
estimate records `{ errors }` without changing the generation result. The field is omitted when no
estimator is supplied or the result has no `usage`.

That `usage` is the AI SDK's `LanguageModelUsage` plus the media usage we record — `usage.image` /
`usage.video` / `usage.audio`, each side an array of `{ input?, output? }`, one entry per produced
item.

## Tool calls

```ts
import { z } from "zod";

const tools = {
  weather: {
    description: "Look up the weather",
    inputSchema: z.object({ city: z.string() }),
  },
};

const run = CoreAgent.request({ conversation, model, tools });
const message = await run.result;
const next = CoreAgent.append(conversation, message);

// calls the model made that the application has not answered yet
const calls = CoreAgent.tools.pending(next);

// validation: the typed path
for (const call of await CoreAgent.tools.validateTyped(calls, { tools })) {
  if (call.kind === "invalid") report(call.diagnostic.issues); // diagnostics are a return value, not an exception
  if (call.kind === "closed" && call.toolName === "weather") {
    call.input.city; // string
  }
}

// supply the results and advance another turn
const answered = CoreAgent.tools.complete(next, [{ toolCallId, output }]);
const second = CoreAgent.request({ conversation: answered, model, tools });
```

`request` ignores `execute` and `needsApproval` on tool definitions: neither field reaches the
model, so a tool call the model makes stops at `input-available`. Execution and approval are the
application's job.

Validation needs a schema that can actually run: zod, Standard Schema, or `jsonSchema` with a
`validate` function all work. A bare JSON Schema description — no executable validator — buys you no
validation, and that call is reported as `invalid`.

Three possible results:

| kind      | meaning                                                                       |
| --------- | ----------------------------------------------------------------------------- |
| `closed`  | a static tool whose input passed validation; `input` is typed from the schema |
| `open`    | a runtime tool declared through `openTools`; input stays `unknown`            |
| `invalid` | unknown tool or invalid input; `diagnostic` carries the issue list            |

`CoreAgent.tools.validate` is the untyped entry point for the same thing: use it when tool
definitions only appear at runtime, in which case `input` on the `closed` branch can only be
`unknown`.

## Persistence

```ts
const wire = CoreAgent.codec.serialize(conversation);
const back = await CoreAgent.codec.deserialize(wire); // fail-closed on a version or structure mismatch
```

`CoreAgent.codec.version` is the current format version. This layer only cares about format —
whether that means a database or any other channel is up to you.

## What this does not do

- No loops and no scheduling: one call per turn; whether to continue is up to the application.
- Does not execute tools, approve anything, or manage side effects.
- Does not store, encrypt, or set retention.
- Does not touch base URLs, credentials, or model selection: those belong to the layer above.
