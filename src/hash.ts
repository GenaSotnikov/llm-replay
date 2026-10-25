import { createHash } from 'node:crypto';
import type { GenerateRequest, Part } from './types.js';

/** SHA-256 of the chunks, each terminated by NUL (so `["a","b"]` ≠ `["ab"]`). */
export function hashChunks(chunks: readonly string[]): string {
  const hash = createHash('sha256');
  for (const chunk of chunks) hash.update(chunk).update('\0');
  return hash.digest('hex');
}

/** SHA-256 of the chunks separated (not terminated) by NUL. */
export function hashJoined(chunks: readonly string[]): string {
  return createHash('sha256').update(chunks.join('\0')).digest('hex');
}

/**
 * Key of a request by its content only: images first, then texts, in order.
 * Stable across prompt-config changes; use it when the inputs (a photo, a
 * cropped fragment) define the answer and the prompt is fixed.
 */
export function hashParts(parts: readonly Part[]): string {
  const images: string[] = [];
  const texts: string[] = [];
  for (const part of parts) {
    if (part.kind === 'image') images.push(part.base64);
    else texts.push(part.text);
  }
  return hashChunks([...images, ...texts]);
}

/**
 * Key of the full request: model, system prompt and every part. Any prompt
 * edit misses, which is what you want for a prompt whose wording is the thing
 * under test.
 */
export function hashRequest(req: GenerateRequest): string {
  const hash = createHash('sha256');
  hash.update(req.model).update('\0');
  hash.update(JSON.stringify(req.system ?? '')).update('\0');
  for (const part of req.parts) {
    hash.update(part.kind === 'image' ? part.base64 : part.text).update('\0');
  }
  return hash.digest('hex');
}
