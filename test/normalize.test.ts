import { describe, expect, it } from 'vitest';
import { hashChunks, hashStable, markVolatile, parseReplayMode, stripVolatile } from '../src/index.js';

describe('normalize', () => {
  it('strips marked spans and keeps the rest', () => {
    expect(stripVolatile(`task${markVolatile(' run 42')} end`)).toBe('task end');
    expect(stripVolatile('no markers')).toBe('no markers');
    expect(stripVolatile('<!-- replay:volatile -->unbalanced')).toBe('<!-- replay:volatile -->unbalanced');
    expect(markVolatile('')).toBe('');
  });

  it('keys the stable text only', () => {
    expect(hashStable('a', `b${markVolatile('x')}`)).toBe(hashChunks(['a', 'b']));
  });
});

describe('parseReplayMode', () => {
  it('defaults to off and rejects garbage', () => {
    expect(parseReplayMode(undefined)).toBe('off');
    expect(parseReplayMode(' ')).toBe('off');
    expect(parseReplayMode('record')).toBe('record');
    expect(parseReplayMode('replay')).toBe('replay');
    expect(() => parseReplayMode('auto', 'LLM_REPLAY')).toThrow(/LLM_REPLAY="auto"/);
  });
});
