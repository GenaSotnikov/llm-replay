/**
 * Provider-neutral shapes of an LLM call.
 *
 * Adapters (`./adapters`) translate a provider SDK's parameters and responses
 * into these, so operations and fixtures never see an SDK type and a fixture
 * recorded through one provider can, in principle, be replayed through another.
 */

/** How the client is wired: real API, real API + save fixtures, fixtures only. */
export type ReplayMode = 'off' | 'record' | 'replay';

export type Part =
  | { readonly kind: 'text'; readonly text: string }
  | { readonly kind: 'image'; readonly mimeType: string; readonly base64: string };

export interface InlineImage {
  readonly mimeType: string;
  readonly base64: string;
}

/** One generation request (text, vision, image generation — anything `generate`). */
export interface GenerateRequest {
  readonly model: string;
  /** The system prompt as the SDK received it (a string or a content object). */
  readonly system: unknown;
  readonly parts: readonly Part[];
  /** The rest of the request config (response schema, modalities…) — for classifiers. */
  readonly config: Readonly<Record<string, unknown>>;
}

export interface GenerateResponse {
  readonly text?: string;
  readonly images?: readonly InlineImage[];
}

/** A streamed answer. Recorded whole; replayed as a single chunk. */
export interface StreamResponse {
  readonly text: string;
}

export interface EmbedRequest {
  readonly model: string;
  readonly taskType?: string;
  readonly dimensions?: number;
  readonly texts: readonly string[];
}

export interface EmbedResponse {
  /** One vector per `texts` entry, same order. */
  readonly vectors: ReadonlyArray<readonly number[]>;
}
