import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it, vi } from 'vitest';
import {
  agentRunOperation,
  type AgentRunRequest,
  type ErrorCodec,
  FixtureStore,
  hashStable,
  MissingFixtureError,
  recordAgentRun,
  recordedError,
  replayAgentRun,
  type SerializedError,
} from '../src/index.js';

const dir = mkdtempSync(join(tmpdir(), 'llm-replay-agent-'));
afterAll(() => rmSync(dir, { recursive: true, force: true }));
const store = new FixtureStore(dir, { recordHint: 'run once with LLM_REPLAY=record' });

class StopError extends Error {
  constructor(
    readonly reason: string,
    message: string,
  ) {
    super(message);
    this.name = 'StopError';
  }
}
const stopCodec: ErrorCodec = {
  encode: (err) =>
    err instanceof StopError ? { name: 'StopError', message: err.message, data: { reason: err.reason } } : undefined,
  decode: (s: SerializedError) => new StopError((s.data as { reason: string }).reason, s.message),
};

const usage = { inputTokens: 10, outputTokens: 5, cacheReadTokens: 0, cacheWriteTokens: 0, totalTokens: 15, costUsd: 0.01 };
const req = (prompt: string, system = 'sys'): AgentRunRequest => ({ agent: 'pm', model: 'm', system, prompt });

describe('agentRunOperation', () => {
  const op = agentRunOperation({
    dir: 'runs',
    key: (r) => hashStable(r.agent, r.prompt),
    errors: stopCodec,
  });

  it('records a successful run with usage and effects and replays it', async () => {
    const effects = [{ bridge: 'documents', method: '()', args: [{ title: 'Plan' }] }];
    const out = await recordAgentRun(
      op,
      req('write a plan'),
      store,
      async () => ({ text: 'the plan', usage, extra: 1 }),
      (r) => ({ text: r.text, usage: r.usage, effects: [] }),
      () => effects,
    );
    expect(out.extra).toBe(1);
    const rec = replayAgentRun(op, req('write a plan'), store);
    expect(rec.outcome).toBe('ok');
    expect(rec.text).toBe('the plan');
    expect(rec.usage).toEqual(usage);
    expect(rec.effects).toEqual(effects);
    expect(readdirSync(join(dir, 'runs'))).toHaveLength(1);
  });

  it('ignores volatile spans in the key', () => {
    const marked = 'write a plan<!-- replay:volatile --> run 42 <!-- /replay:volatile -->';
    expect(replayAgentRun(op, req(marked), store).text).toBe('the plan');
  });

  it('records a failure through the codec and replays it as the same error', async () => {
    await expect(
      recordAgentRun(
        op,
        req('explode'),
        store,
        async () => {
          throw new StopError('truncated', 'cut off');
        },
        () => ({ text: '', usage: null, effects: [] }),
      ),
    ).rejects.toThrow('cut off');
    const rec = replayAgentRun(op, req('explode'), store);
    expect(rec.outcome).toBe('error');
    const err = recordedError(op, rec);
    expect(err).toBeInstanceOf(StopError);
    expect((err as StopError).reason).toBe('truncated');
  });

  it('does not record a failure the codec declines', async () => {
    await expect(
      recordAgentRun(
        op,
        req('harness bug'),
        store,
        async () => {
          throw new TypeError('not a model outcome');
        },
        () => ({ text: '', usage: null, effects: [] }),
      ),
    ).rejects.toThrow(TypeError);
    expect(() => replayAgentRun(op, req('harness bug'), store)).toThrow(MissingFixtureError);
  });

  it('a miss names the agent and the record hint', () => {
    expect(() => replayAgentRun(op, req('never recorded'), store)).toThrow(/pm .* — run once with LLM_REPLAY=record/);
  });

  it('warns about prompt drift on a hit recorded with another system prompt', async () => {
    const onDrift = vi.fn();
    const drifting = agentRunOperation({ dir: 'runs', key: (r) => hashStable(r.agent, r.prompt), onDrift });
    await recordAgentRun(
      drifting,
      req('drift', 'old system'),
      store,
      async () => 'x',
      () => ({ text: 'x', usage: null, effects: [] }),
    );
    replayAgentRun(drifting, req('drift', 'old system'), store);
    expect(onDrift).not.toHaveBeenCalled();
    replayAgentRun(drifting, req('drift', 'new system'), store);
    expect(onDrift).toHaveBeenCalledWith(expect.objectContaining({ agent: 'pm' }));
  });

  it('writes a file a human can edit: a hand-written failure replays', () => {
    const r = req('hand written');
    const key = op.key(r);
    store.writeJson(`runs/${key}.json`, {
      outcome: 'error',
      agent: 'pm',
      model: 'm',
      promptDigest: 'whatever',
      recordedAt: '2026-01-01T00:00:00.000Z',
      text: '',
      usage: null,
      effects: [],
      error: { name: 'StopError', message: 'budget gone', data: { reason: 'budget' } },
    });
    const quiet = agentRunOperation({ dir: 'runs', key: op.key, errors: stopCodec, onDrift: () => {} });
    const rec = replayAgentRun(quiet, r, store);
    expect((recordedError(quiet, rec) as StopError).reason).toBe('budget');
    expect(readFileSync(join(dir, 'runs', `${key}.json`), 'utf8')).toContain('budget gone');
  });
});
