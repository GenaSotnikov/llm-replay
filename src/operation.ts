import { MissingFixtureError } from './errors.js';
import type { FixtureStore } from './store.js';

/**
 * One kind of LLM call and how its answers are kept. The project defines its
 * operations (what keys an answer, where it lives, what to do on a miss); the
 * adapter decides which operation a request belongs to.
 */
export interface Operation<Req, Res> {
  /** Named in miss errors and record warnings. */
  readonly name: string;
  /** Save one real answer. A throw here is caught and warned — it never fails the real call. */
  record(req: Req, res: Res, store: FixtureStore): void;
  /**
   * Serve a recorded answer, or `undefined` when none was recorded. An
   * operation that knows which part is missing may throw MissingFixtureError
   * itself.
   */
  replay(req: Req, store: FixtureStore): Res | undefined;
  /** Short description of the request for the miss error (the key by default). */
  describe?(req: Req): string;
  /** Answer to serve instead of throwing on a miss. */
  onMiss?(req: Req): Res;
}

export function replayOperation<Req, Res>(op: Operation<Req, Res>, req: Req, store: FixtureStore): Res {
  const hit = op.replay(req, store);
  if (hit !== undefined) return hit;
  if (op.onMiss) return op.onMiss(req);
  throw new MissingFixtureError(op.name, op.describe?.(req) ?? 'this request', store.recordHint);
}

export type Warn = (message: string) => void;

export function recordOperation<Req, Res>(
  op: Operation<Req, Res>,
  req: Req,
  res: Res,
  store: FixtureStore,
  warn: Warn = (message) => console.warn(message),
): void {
  try {
    op.record(req, res, store);
  } catch (err: unknown) {
    const detail = err instanceof Error ? err.message : String(err);
    warn(`[llm-replay] failed to record ${op.name} fixture: ${detail}`);
  }
}

export interface JsonMapOperationOptions<Req, Res, Stored> {
  readonly name: string;
  /** JSON file (relative to the store) holding `{ [key]: Stored }`. */
  readonly file: string;
  key(req: Req): string;
  /** The value to store, or `undefined` to skip (an unparseable answer must not poison the file). */
  encode(res: Res, req: Req): Stored | undefined;
  decode(stored: Stored, req: Req): Res;
  onMiss?(req: Req): Res;
}

/** Many small answers in one JSON file, one entry per key. */
export function jsonMapOperation<Req, Res, Stored>(
  o: JsonMapOperationOptions<Req, Res, Stored>,
): Operation<Req, Res> {
  const onMiss = o.onMiss;
  return {
    name: o.name,
    describe: (req) => o.key(req),
    ...(onMiss ? { onMiss: (req: Req) => onMiss(req) } : {}),
    record(req, res, store) {
      const value = o.encode(res, req);
      if (value === undefined) return;
      store.updateJson<Record<string, Stored>>(o.file, {}, (map) => {
        map[o.key(req)] = value;
      });
    },
    replay(req, store) {
      const hit = store.readJson<Record<string, Stored>>(o.file, {})[o.key(req)];
      return hit === undefined ? undefined : o.decode(hit, req);
    },
  };
}

export interface BinaryFileOperationOptions<Req, Res> {
  readonly name: string;
  /** Directory (relative to the store) holding `<key><extension>` files. */
  readonly dir: string;
  /** With the dot: `.png`, `.f32`. */
  readonly extension: string;
  key(req: Req): string;
  /** The bytes to store, or `undefined` to skip. */
  encode(res: Res, req: Req): Buffer | undefined;
  decode(data: Buffer, req: Req): Res;
  onMiss?(req: Req): Res;
}

/** One file per answer — images, audio, anything big. */
export function binaryFileOperation<Req, Res>(o: BinaryFileOperationOptions<Req, Res>): Operation<Req, Res> {
  const file = (req: Req): string => `${o.dir}/${o.key(req)}${o.extension}`;
  const onMiss = o.onMiss;
  return {
    name: o.name,
    describe: (req) => o.key(req),
    ...(onMiss ? { onMiss: (req: Req) => onMiss(req) } : {}),
    record(req, res, store) {
      const data = o.encode(res, req);
      if (data !== undefined) store.writeBinary(file(req), data);
    },
    replay(req, store) {
      const path = file(req);
      return store.has(path) ? o.decode(store.readBinary(path), req) : undefined;
    },
  };
}

export interface JsonFileOperationOptions<Req, Res, Stored> {
  readonly name: string;
  /** Directory (relative to the store) holding `<key>.json` files. */
  readonly dir: string;
  key(req: Req): string;
  /** The value to store, or `undefined` to skip. */
  encode(res: Res, req: Req): Stored | undefined;
  decode(stored: Stored, req: Req): Res;
  onMiss?(req: Req): Res;
}

/**
 * One JSON file per answer. Unlike `jsonMapOperation` there is no shared file
 * to read-modify-write, so parallel recordings of different keys are safe.
 */
export function jsonFileOperation<Req, Res, Stored>(o: JsonFileOperationOptions<Req, Res, Stored>): Operation<Req, Res> {
  const file = (req: Req): string => `${o.dir}/${o.key(req)}.json`;
  const onMiss = o.onMiss;
  return {
    name: o.name,
    describe: (req) => o.key(req),
    ...(onMiss ? { onMiss: (req: Req) => onMiss(req) } : {}),
    record(req, res, store) {
      const value = o.encode(res, req);
      if (value !== undefined) store.writeJson(file(req), value);
    },
    replay(req, store) {
      const path = file(req);
      if (!store.has(path)) return undefined;
      const stored = store.readJson<{ value: Stored } | Stored | null>(path, null);
      return stored === null ? undefined : o.decode(stored as Stored, req);
    },
  };
}
