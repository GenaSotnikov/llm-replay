import { describe, expect, it } from 'vitest';
import { hashChunks, hashJoined, hashParts, hashRequest } from '../src/index.js';

describe('hashes', () => {
  it('terminates chunks so a split changes the key', () => {
    expect(hashChunks(['a', 'b'])).not.toBe(hashChunks(['ab']));
    expect(hashChunks(['a', 'b'])).not.toBe(hashJoined(['a', 'b']));
  });

  it('keys parts by images first, then texts, regardless of order', () => {
    const a = hashParts([{ kind: 'text', text: 'p' }, { kind: 'image', mimeType: 'image/png', base64: 'AA' }]);
    const b = hashParts([{ kind: 'image', mimeType: 'image/png', base64: 'AA' }, { kind: 'text', text: 'p' }]);
    expect(a).toBe(b);
    expect(a).toBe(hashChunks(['AA', 'p']));
  });

  it('keys a request by model, system prompt and parts', () => {
    const base = { model: 'm', system: 'sys', parts: [{ kind: 'text', text: 't' }] as const, config: {} };
    expect(hashRequest(base)).toBe(hashRequest({ ...base, config: { temperature: 0 } }));
    expect(hashRequest(base)).not.toBe(hashRequest({ ...base, system: 'other' }));
    expect(hashRequest(base)).not.toBe(hashRequest({ ...base, model: 'n' }));
  });
});
