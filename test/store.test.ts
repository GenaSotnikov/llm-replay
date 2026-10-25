import { mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { FixtureStore, jsonFileOperation, recordOperation, replayOperation } from '../src/index.js';

const dir = mkdtempSync(join(tmpdir(), 'llm-replay-store-'));
afterAll(() => rmSync(dir, { recursive: true, force: true }));
const store = new FixtureStore(dir);

describe('store', () => {
  it('writes atomically: no temp files are left behind', () => {
    store.writeJson('a/b.json', { x: 1 });
    store.writeBinary('a/c.bin', Buffer.from('zz'));
    expect(readdirSync(join(dir, 'a')).sort()).toEqual(['b.json', 'c.bin']);
    expect(store.readJson('a/b.json', null)).toEqual({ x: 1 });
  });

  it('jsonFileOperation keeps one file per key', () => {
    const op = jsonFileOperation<{ q: string }, { a: string }, string>({
      name: 'qa',
      dir: 'qa',
      key: (r) => r.q,
      encode: (res) => res.a,
      decode: (s) => ({ a: s }),
    });
    recordOperation(op, { q: 'one' }, { a: '1' }, store);
    recordOperation(op, { q: 'two' }, { a: '2' }, store);
    expect(readdirSync(join(dir, 'qa')).sort()).toEqual(['one.json', 'two.json']);
    expect(replayOperation(op, { q: 'two' }, store)).toEqual({ a: '2' });
    expect(() => replayOperation(op, { q: 'three' }, store)).toThrow(/no qa fixture for three/);
  });
});
