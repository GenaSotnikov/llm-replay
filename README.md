# llm-replay

Record real LLM answers once, replay them for free. Provider-neutral fixtures
for e2e and integration tests of anything that calls a model: text generation,
structured JSON, vision, image generation, streaming, embeddings.

Zero runtime dependencies. Node 20+. Ships a `@google/genai` adapter; the core
is SDK-agnostic.

## The use case it came from

The approach was built for **Telepon**, an AAC (augmentative and alternative
communication) messaging app, whose end-to-end suite drives the real mobile app
on an Android emulator (Maestro) against the real backend. Two flows in that
suite are LLM pipelines end to end:

- **Photo board import.** A caregiver photographs a paper communication board.
  The backend sends the photos to Gemini vision (bounding boxes and labels of
  every card), crops each card, asks an image model to redraw it as a clean
  pictogram, then asks a text model to translate every label into every
  supported locale. One import is 20–40 model calls, several of them image
  generation.
- **Text to symbols.** A sentence typed by the caregiver goes through a
  three-step translation pipeline (decompose, embed and match against the
  symbol catalog, assemble), with embeddings of the custom symbols the import
  just created.

Running that suite against the live API had three problems:

1. **Cost.** Every run of every flow spent image-generation tokens, so nobody
   wanted to run the suite often, and CI could not run it at all.
2. **Non-determinism.** The vision model returned a slightly different set of
   cards from one run to the next, so the suite could not assert on counts
   ("12 symbols imported") or on which symbols appear in the board.
3. **Offline.** A laptop on a train, or a CI runner without the API key, had
   no way to run the flow.

A record/replay layer on the SDK client solved all three with one real run:
`GEMINI_MOCK=record` runs the suite against the live API and saves every answer
as a fixture; `GEMINI_MOCK=replay` (the default) serves the fixtures with no
key and no network, deterministically. The suite went from "someone runs it
before a release" to "runs on every push", with exact assertions.

Two lessons shaped the design:

- **Fixtures are keyed semantically, per kind of call, not by raw HTTP body.**
  A vision answer is keyed by the photos and the prompt; a redrawn pictogram by
  the cropped fragment; a label translation by the label; an embedding by the
  text. Vision fixes the bounding boxes, the boxes fix the crops, the crops fix
  the image keys, so the whole chain replays from one recording. HTTP-level
  recorders (nock, Polly) see base64 blobs and SSE streams and cannot do this.
- **Recording is write-only.** An early "fill the gaps" mode read existing
  fixtures while recording. Photos re-encoded by a different emulator hashed
  differently, half the set came from the old machine, and the result was an
  inconsistent board. A record run now refreshes everything it touches.

The layer first lived inside the app's Gemini module with its kinds of call
hard-coded. This package is that layer with the project-specific parts pulled
out into *operations* the project defines.

## Model

```
            project defines                      package provides
   ┌──────────────────────────────┐     ┌─────────────────────────────────┐
   │ Operation: how one kind of   │     │ FixtureStore   dir of fixtures   │
   │ call is keyed, stored,       │ ──▶ │ adapters       SDK ⇄ neutral     │
   │ replayed, and what a miss    │     │                shapes, modes     │
   │ falls back to                │     │ hashes         standard keys     │
   └──────────────────────────────┘     └─────────────────────────────────┘
```

- **Neutral shapes** (`GenerateRequest`, `GenerateResponse`, `StreamResponse`,
  `EmbedRequest`, `EmbedResponse`): what an adapter turns SDK calls into, so
  operations and fixtures never see an SDK type.
- **`Operation<Req, Res>`**: `record`, `replay`, optional `describe` and
  `onMiss`. Helpers cover the usual storage: `jsonMapOperation` (many small
  answers in one JSON file), `binaryFileOperation` (one file per answer),
  `embeddingOperation` (one float32 vector per text, shared across batches).
- **Keys**: `hashRequest` (model + system prompt + every part; any prompt edit
  misses) and `hashParts` (inputs only; the prompt is fixed, the photo decides).
- **Adapter**: `createGeminiRecordingClient(real, store, ops)` wraps the real
  client and saves every answer; `createGeminiReplayClient(store, ops)` serves
  fixtures and never touches the network. Both implement the `models` methods
  of `GoogleGenAI` structurally — cast to the SDK type at the boundary.

## Usage

```ts
import type { GoogleGenAI } from '@google/genai';
import {
  FixtureStore, jsonMapOperation, binaryFileOperation, embeddingOperation,
  hashParts, hashRequest, type GenerateRequest, type GenerateResponse, type StreamResponse,
} from 'llm-replay';
import { createGeminiRecordingClient, createGeminiReplayClient, type GeminiOperations } from 'llm-replay/gemini';

const store = new FixtureStore(new URL('./fixtures', import.meta.url).pathname, {
  recordHint: 'run once with GEMINI_MOCK=record',
});

const vision = jsonMapOperation<GenerateRequest, GenerateResponse, unknown>({
  name: 'vision', file: 'vision.json',
  key: (req) => hashParts(req.parts),                 // the photos decide
  encode: (res) => tryParseJson(res.text),            // undefined → not recorded
  decode: (stored) => ({ text: JSON.stringify(stored) }),
});
const image = binaryFileOperation<GenerateRequest, GenerateResponse>({
  name: 'image', dir: 'images', extension: '.png',
  key: (req) => hashParts(req.parts),
  encode: (res) => res.images?.[0] && Buffer.from(res.images[0].base64, 'base64'),
  decode: (data) => ({ images: [{ mimeType: 'image/png', base64: data.toString('base64') }] }),
});
const generate = jsonMapOperation<GenerateRequest, GenerateResponse, string>({
  name: 'generate', file: 'generate.json',
  key: hashRequest,                                   // the prompt is under test
  encode: (res) => res.text,
  decode: (text) => ({ text }),
});

const ops: GeminiOperations = {
  classify: (req) => {
    if (req.model.includes('image')) return image;
    const schema = req.config['responseSchema'] as { properties?: Record<string, unknown> } | undefined;
    return schema?.properties?.['symbols'] ? vision : generate;
  },
  stream: jsonMapOperation<GenerateRequest, StreamResponse, string>({
    name: 'stream', file: 'stream.json', key: hashRequest,
    encode: (res) => res.text, decode: (text) => ({ text }),
  }),
  embed: embeddingOperation({ dir: 'embeddings' }),
};

export function geminiClient(mode: 'off' | 'record' | 'replay', apiKey?: string): GoogleGenAI {
  if (mode === 'replay') return createGeminiReplayClient(store, ops) as unknown as GoogleGenAI;
  const real = new GoogleGenAI({ apiKey });
  return mode === 'record'
    ? (createGeminiRecordingClient(real, store, ops) as unknown as GoogleGenAI)
    : real;
}
```

A miss on replay rejects with
`[llm-replay] no vision fixture for <key> — run once with GEMINI_MOCK=record`,
like a failed API call would. An operation with `onMiss` answers instead —
useful for a call whose unknown inputs have an obvious stand-in (a label
translation that echoes the source name).

### Things to keep in mind

- **Replay bypasses your caches too.** If the app memoises model answers (a
  Redis cache keyed by input), skip it in record and replay, or a cached real
  answer short-circuits the call and nothing is recorded or replayed.
- **Record is write-only.** It always calls the API and overwrites. Wipe the
  fixture directory before a record run meant to produce a clean set; stale
  keys are never overwritten, only orphaned.
- **Chained keys.** When an answer feeds the inputs of the next call (vision
  boxes → crops → image generation), re-recording the first means re-recording
  the chain. Do it in one run.
- **Inputs must be byte-stable across environments** for `hashParts` keys.
  Photos re-encoded by a device's gallery differ per device; upload test assets
  through the API where you can.
- **Streams replay as one chunk.** Enough for pipelines that consume the
  whole text; not for testing streaming UI.
- **Fixtures are data, commit them.** JSON stays small; a set of PNGs is a few
  MB. The suite then runs with no key on every push.

## Development

```bash
npm install
npm test
npm run typecheck
npm run build        # dist/, also run by `prepare` when installed from git
```

Consume from another project before publishing with a git dependency:

```json
"llm-replay": "github:<owner>/llm-replay#v0.1.0"
```

## Roadmap

- Record and replay token usage, so cost accounting is testable.
- Named cassettes per scenario with a manifest: orphan GC, diff of two
  recordings, an `auto` mode (replay on hit, record on miss) that is safe.
- Prompt-drift report: a key hit whose prompt digest changed warns in dev and
  fails in CI.
- Fault injection on replay (timeout, 429, malformed JSON on the n-th call).
- Streams with chunk boundaries. A second provider adapter.
