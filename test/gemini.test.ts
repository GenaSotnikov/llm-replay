import { mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it, vi } from 'vitest';
import {
  createGeminiRecordingClient,
  createGeminiReplayClient,
  type GeminiLikeClient,
  type GeminiOperations,
} from '../src/adapters/gemini.js';
import {
  binaryFileOperation,
  embeddingOperation,
  FixtureStore,
  type GenerateRequest,
  type GenerateResponse,
  hashParts,
  hashRequest,
  jsonMapOperation,
  type StreamResponse,
} from '../src/index.js';

const dir = mkdtempSync(join(tmpdir(), 'llm-replay-'));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

const store = new FixtureStore(dir, { recordHint: 'run once with LLM_MOCK=record' });

const text = jsonMapOperation<GenerateRequest, GenerateResponse, string>({
  name: 'generate',
  file: 'generate.json',
  key: hashRequest,
  encode: (res) => res.text,
  decode: (stored) => ({ text: stored }),
});
const image = binaryFileOperation<GenerateRequest, GenerateResponse>({
  name: 'image',
  dir: 'images',
  extension: '.png',
  key: (req) => hashParts(req.parts),
  encode: (res) => (res.images?.[0] ? Buffer.from(res.images[0].base64, 'base64') : undefined),
  decode: (data) => ({ images: [{ mimeType: 'image/png', base64: data.toString('base64') }] }),
});
const ops: GeminiOperations = {
  classify: (req) => (req.model.includes('image') ? image : text),
  stream: jsonMapOperation<GenerateRequest, StreamResponse, string>({
    name: 'stream',
    file: 'stream.json',
    key: hashRequest,
    encode: (res) => res.text,
    decode: (stored) => ({ text: stored }),
  }),
  embed: embeddingOperation({ dir: 'embeddings' }),
};

const PNG = Buffer.from('not really a png').toString('base64');
const real = {
  models: {
    generateContent: vi.fn(async (params: { model?: string }) =>
      params.model?.includes('image')
        ? { candidates: [{ content: { parts: [{ inlineData: { mimeType: 'image/png', data: PNG } }] } }] }
        : { text: '{"words":["apple"]}' },
    ),
    generateContentStream: vi.fn(async () =>
      (async function* () {
        yield { text: 'SEQ|0|' };
        yield { text: '0.9|3' };
      })(),
    ),
    embedContent: vi.fn(async (params: { contents: unknown }) => ({
      embeddings: (Array.isArray(params.contents) ? params.contents : [params.contents]).map((_, i) => ({
        values: [0.5 + i, -0.25, 1],
      })),
    })),
  },
} as unknown as GeminiLikeClient;

const GENERATE = {
  model: 'gemini-x',
  contents: [{ role: 'user', parts: [{ text: 'I want an apple' }] }],
  config: { systemInstruction: 'step 1 prompt' },
};
const IMAGE = {
  model: 'gemini-image',
  contents: [{ role: 'user', parts: [{ inlineData: { mimeType: 'image/jpeg', data: 'AAAA' } }, { text: 'copy it' }] }],
};
const EMBED_BATCH = {
  model: 'gemini-embedding-001',
  contents: [{ role: 'user', parts: [{ text: 'apple' }] }, { role: 'user', parts: [{ text: 'want' }] }],
  config: { taskType: 'RETRIEVAL_QUERY', outputDimensionality: 3 },
};

async function collect(stream: AsyncGenerator<{ text?: string }>): Promise<string> {
  let out = '';
  for await (const chunk of stream) out += chunk.text ?? '';
  return out;
}

describe('gemini adapter — record then replay', () => {
  it('records every call through the real client, untouched', async () => {
    const recording = createGeminiRecordingClient(real, store, ops);
    expect((await recording.models.generateContent(GENERATE)).text).toBe('{"words":["apple"]}');
    expect(await collect(await recording.models.generateContentStream(GENERATE))).toBe('SEQ|0|0.9|3');
    await recording.models.generateContent(IMAGE);
    await recording.models.embedContent(EMBED_BATCH);
    expect(real.models.generateContent).toHaveBeenCalledTimes(2);
    expect(readdirSync(dir).sort()).toEqual(['embeddings', 'generate.json', 'images', 'stream.json']);
  });

  it('replays a generateContent by its full request', async () => {
    const replay = createGeminiReplayClient(store, ops);
    expect((await replay.models.generateContent(GENERATE)).text).toBe('{"words":["apple"]}');
  });

  it('misses when the system prompt differs, naming the project hint', async () => {
    const replay = createGeminiReplayClient(store, ops);
    await expect(
      replay.models.generateContent({ ...GENERATE, config: { systemInstruction: 'other' } }),
    ).rejects.toThrow(/no generate fixture for \w+ — run once with LLM_MOCK=record/);
  });

  it('replays an image as inlineData from its file', async () => {
    const replay = createGeminiReplayClient(store, ops);
    const res = await replay.models.generateContent(IMAGE);
    expect(res.candidates?.[0]?.content?.parts?.[0]?.inlineData?.data).toBe(PNG);
  });

  it('replays a stream as its whole text', async () => {
    const replay = createGeminiReplayClient(store, ops);
    expect(await collect(await replay.models.generateContentStream(GENERATE))).toBe('SEQ|0|0.9|3');
  });

  it('replays embeddings per text, whether batched or single', async () => {
    const replay = createGeminiReplayClient(store, ops);
    const single = await replay.models.embedContent({
      model: 'gemini-embedding-001',
      contents: 'want',
      config: { taskType: 'RETRIEVAL_QUERY', outputDimensionality: 3 },
    });
    expect(single.embeddings?.[0]?.values).toEqual([1.5, -0.25, 1]);
    await expect(replay.models.embedContent({ ...EMBED_BATCH, contents: 'pear' })).rejects.toThrow(
      'no embedding fixture for "pear"',
    );
  });

  it('serves onMiss instead of throwing when the operation has one', async () => {
    const lenient: GeminiOperations = {
      ...ops,
      classify: () =>
        jsonMapOperation<GenerateRequest, GenerateResponse, string>({
          name: 'labels',
          file: 'labels.json',
          key: hashRequest,
          encode: (res) => res.text,
          decode: (stored) => ({ text: stored }),
          onMiss: () => ({ text: '{"items":[]}' }),
        }),
    };
    const replay = createGeminiReplayClient(store, lenient);
    expect((await replay.models.generateContent({ model: 'x', contents: 'anything' })).text).toBe('{"items":[]}');
  });
});
