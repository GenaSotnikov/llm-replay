/**
 * Adapter for `@google/genai`'s `GoogleGenAI` client.
 *
 * Typed structurally — only the three `models` methods the pipeline uses — so
 * the package does not depend on the SDK. Cast the result to `GoogleGenAI`
 * where the app expects the real type: `createGeminiReplayClient(...) as
 * unknown as GoogleGenAI`.
 */

import { type Operation, recordOperation, replayOperation, type Warn } from '../operation.js';
import type { FixtureStore } from '../store.js';
import type {
  EmbedRequest,
  EmbedResponse,
  GenerateRequest,
  GenerateResponse,
  InlineImage,
  Part,
  StreamResponse,
} from '../types.js';

// --- the SDK surface we touch ---------------------------------------------

export interface GeminiGenerateParams {
  model?: string;
  contents?: unknown;
  config?: Readonly<Record<string, unknown>> & { systemInstruction?: unknown };
}
export interface GeminiGenerateResponse {
  text?: string;
  candidates?: Array<{
    content?: { parts?: Array<{ inlineData?: { data?: string; mimeType?: string }; text?: string }> };
  }>;
}
export interface GeminiStreamChunk {
  text?: string;
}
export interface GeminiEmbedParams {
  model?: string;
  contents?: unknown;
  config?: { taskType?: string; outputDimensionality?: number };
}
export interface GeminiEmbedResponse {
  embeddings?: Array<{ values?: number[] }>;
}

/** The part of `GoogleGenAI` this adapter implements and wraps. */
export interface GeminiLikeClient {
  models: {
    generateContent(params: GeminiGenerateParams): Promise<GeminiGenerateResponse>;
    generateContentStream(params: GeminiGenerateParams): Promise<AsyncGenerator<GeminiStreamChunk>>;
    embedContent(params: GeminiEmbedParams): Promise<GeminiEmbedResponse>;
  };
}

/** The project's operations: which one answers a `generateContent`, plus stream and embed. */
export interface GeminiOperations {
  /** Pick the operation for a generate request (vision, image, plain text…). */
  classify(req: GenerateRequest): Operation<GenerateRequest, GenerateResponse>;
  stream: Operation<GenerateRequest, StreamResponse>;
  embed: Operation<EmbedRequest, EmbedResponse>;
}

export interface GeminiAdapterOptions {
  readonly warn?: Warn;
}

// --- normalisation ---------------------------------------------------------

function firstContentParts(contents: unknown): unknown[] {
  const first = Array.isArray(contents) ? contents[0] : contents;
  return first && typeof first === 'object' && 'parts' in first
    ? ((first as { parts?: unknown[] }).parts ?? [])
    : [];
}

export function toGenerateRequest(params: GeminiGenerateParams): GenerateRequest {
  const parts: Part[] = [];
  for (const raw of firstContentParts(params.contents)) {
    if (!raw || typeof raw !== 'object') continue;
    const p = raw as { inlineData?: { data?: string; mimeType?: string }; text?: string };
    if (typeof p.inlineData?.data === 'string') {
      parts.push({ kind: 'image', mimeType: p.inlineData.mimeType ?? 'image/png', base64: p.inlineData.data });
    }
    if (typeof p.text === 'string') parts.push({ kind: 'text', text: p.text });
  }
  const { systemInstruction, ...config } = params.config ?? {};
  return { model: String(params.model ?? ''), system: systemInstruction, parts, config };
}

export function fromGenerateResponse(res: GeminiGenerateResponse): GenerateResponse {
  const images: InlineImage[] = [];
  for (const candidate of res.candidates ?? []) {
    for (const part of candidate.content?.parts ?? []) {
      if (part.inlineData?.data) {
        images.push({ mimeType: part.inlineData.mimeType ?? 'image/png', base64: part.inlineData.data });
      }
    }
  }
  return {
    ...(res.text !== undefined ? { text: res.text } : {}),
    ...(images.length ? { images } : {}),
  };
}

export function toGeminiResponse(res: GenerateResponse): GeminiGenerateResponse {
  return {
    ...(res.text !== undefined ? { text: res.text } : {}),
    ...(res.images?.length
      ? {
          candidates: [
            {
              content: {
                parts: res.images.map((img) => ({ inlineData: { mimeType: img.mimeType, data: img.base64 } })),
              },
            },
          ],
        }
      : {}),
  };
}

/** The texts of an embed request (a string, strings, or Content[]). */
export function toEmbedRequest(params: GeminiEmbedParams): EmbedRequest {
  const contents = params.contents;
  const items = Array.isArray(contents) ? contents : [contents];
  const texts = items.map((item) => {
    if (typeof item === 'string') return item;
    const parts = (item as { parts?: Array<{ text?: string }> } | undefined)?.parts ?? [];
    return parts.map((p) => p.text ?? '').join('');
  });
  const taskType = params.config?.taskType;
  const dimensions = params.config?.outputDimensionality;
  return {
    model: String(params.model ?? ''),
    texts,
    ...(taskType !== undefined ? { taskType } : {}),
    ...(dimensions !== undefined ? { dimensions } : {}),
  };
}

// --- clients ---------------------------------------------------------------

/** A client that serves fixtures and never touches the network. */
export function createGeminiReplayClient(store: FixtureStore, ops: GeminiOperations): GeminiLikeClient {
  return {
    models: {
      // async: a miss rejects, like a failed API call would.
      async generateContent(params) {
        const req = toGenerateRequest(params);
        return toGeminiResponse(replayOperation(ops.classify(req), req, store));
      },
      async generateContentStream(params) {
        const { text } = replayOperation(ops.stream, toGenerateRequest(params), store);
        return (async function* () {
          yield { text };
        })();
      },
      async embedContent(params) {
        const { vectors } = replayOperation(ops.embed, toEmbedRequest(params), store);
        return { embeddings: vectors.map((values) => ({ values: [...values] })) };
      },
    },
  };
}

/**
 * Wraps the real client: every call goes to the API and its answer is saved.
 * Write-only by design — it never reads a fixture back, so one record run
 * refreshes the whole set for the current inputs and nothing stale survives.
 */
export function createGeminiRecordingClient(
  real: GeminiLikeClient,
  store: FixtureStore,
  ops: GeminiOperations,
  options: GeminiAdapterOptions = {},
): GeminiLikeClient {
  const warn = options.warn;
  const realGenerate = real.models.generateContent.bind(real.models);
  const realStream = real.models.generateContentStream.bind(real.models);
  const realEmbed = real.models.embedContent.bind(real.models);

  return {
    models: {
      async generateContent(params) {
        const response = await realGenerate(params);
        const req = toGenerateRequest(params);
        recordOperation(ops.classify(req), req, fromGenerateResponse(response), store, warn);
        return response;
      },
      async generateContentStream(params) {
        const stream = await realStream(params);
        return (async function* () {
          let text = '';
          for await (const chunk of stream) {
            text += chunk.text ?? '';
            yield chunk;
          }
          recordOperation(ops.stream, toGenerateRequest(params), { text }, store, warn);
        })();
      },
      async embedContent(params) {
        const response = await realEmbed(params);
        const vectors = (response.embeddings ?? []).map((e) => e.values ?? []);
        recordOperation(ops.embed, toEmbedRequest(params), { vectors }, store, warn);
        return response;
      },
    },
  };
}
