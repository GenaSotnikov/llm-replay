import { describe, expect, it } from 'vitest';
import { applyEffects, CALLABLE, recordingProxy, type AgentEffect } from '../src/index.js';

describe('effects', () => {
  it('records method calls on an object bridge in order, with results and errors', async () => {
    const log: AgentEffect[] = [];
    const real = {
      async write(path: string, content: string) {
        return `${path}:${content.length}`;
      },
      async fail() {
        throw new Error('nope');
      },
      count: 3,
    };
    const bridge = recordingProxy(real, 'sandbox', log);
    expect(bridge.count).toBe(3);
    await bridge.write('a.txt', 'hello');
    await expect(bridge.fail()).rejects.toThrow('nope');
    expect(log).toEqual([
      { bridge: 'sandbox', method: 'write', args: ['a.txt', 'hello'], result: 'a.txt:5' },
      { bridge: 'sandbox', method: 'fail', args: [], error: 'nope' },
    ]);
  });

  it('records a bare function bridge', async () => {
    const log: AgentEffect[] = [];
    const sink = recordingProxy(async (doc: { title: string }) => doc.title, 'documents', log);
    expect(await sink({ title: 'Plan' })).toBe('Plan');
    expect(log).toEqual([{ bridge: 'documents', method: CALLABLE, args: [{ title: 'Plan' }], result: 'Plan' }]);
  });

  it('re-applies effects through bridges of the same names, sequentially', async () => {
    const calls: string[] = [];
    const bridges = {
      sandbox: {
        async write(path: string) {
          calls.push(`write ${path}`);
        },
      },
      documents: async (doc: { title: string }) => {
        calls.push(`doc ${doc.title}`);
      },
    };
    await applyEffects(
      [
        { bridge: 'sandbox', method: 'write', args: ['a'] },
        { bridge: 'documents', method: CALLABLE, args: [{ title: 'Plan' }] },
        { bridge: 'sandbox', method: 'write', args: ['b'] },
      ],
      bridges,
    );
    expect(calls).toEqual(['write a', 'doc Plan', 'write b']);
  });

  it('fails on a missing bridge unless told to skip', async () => {
    const effects = [{ bridge: 'delegate', method: 'delegate', args: [] }];
    await expect(applyEffects(effects, {})).rejects.toThrow(/bridge "delegate"/);
    await expect(applyEffects(effects, {}, { missingBridge: 'skip' })).resolves.toBeUndefined();
  });
});
