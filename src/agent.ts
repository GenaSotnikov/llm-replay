/**
 * The second neutral family: a whole AGENT RUN rather than one model call.
 *
 * An orchestrator that drives `claude -p`, a coding-agent RPC or an in-process
 * agent loop never sees individual API requests — it sees a turn: a prompt in,
 * and out come a final text, token usage, a success-or-failure outcome and the
 * side effects the agent caused through the project's bridges. That turn is
 * what gets recorded and replayed here. The adapter that maps a project's
 * provider interface onto these shapes lives in the project.
 */
import type { AgentEffect } from './effects.js';
import { MissingFixtureError } from './errors.js';
import { hashChunks } from './hash.js';
import type { Operation } from './operation.js';
import { recordOperation, replayOperation } from './operation.js';
import type { FixtureStore } from './store.js';

export interface AgentRunRequest {
  /** Who is answering (the role), as the project names it. */
  readonly agent: string;
  readonly model: string;
  readonly system: string;
  readonly prompt: string;
  /** Anything else a key function or `describe` may want (ids, flags). Not stored. */
  readonly meta?: Readonly<Record<string, unknown>>;
}

export interface AgentUsage {
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly cacheReadTokens: number;
  readonly cacheWriteTokens: number;
  readonly totalTokens: number;
  readonly costUsd: number;
}

/** A project error flattened to data. `data` carries the fields the project's codec keeps. */
export interface SerializedError {
  readonly name: string;
  readonly message: string;
  readonly data?: unknown;
}

export interface AgentRunRecord {
  readonly outcome: 'ok' | 'error';
  readonly agent: string;
  readonly model: string;
  /** Digest of model + system prompt at recording time — see `onDrift`. */
  readonly promptDigest: string;
  readonly recordedAt: string;
  /** The answer; empty when the run failed. */
  readonly text: string;
  /** `null` when the run died before reporting usage. */
  readonly usage: AgentUsage | null;
  readonly effects: readonly AgentEffect[];
  readonly error?: SerializedError;
}

/** What the project hands in after a real run, before it becomes a record. */
export interface AgentRunOutcome {
  readonly text: string;
  readonly usage: AgentUsage | null;
  readonly effects: readonly AgentEffect[];
}

/**
 * How a project's failures cross the fixture boundary. `encode` returns
 * `undefined` to say "do not record this one" (a bug in the test harness is
 * not a model outcome); `decode` must rebuild an error the project tells
 * apart the same way it tells apart the live one (by class and fields, not
 * by message).
 */
export interface ErrorCodec {
  encode(err: unknown): SerializedError | undefined;
  decode(stored: SerializedError): Error;
}

/** Name, message and nothing else; decodes to a plain `Error` with the recorded name. */
export const plainErrorCodec: ErrorCodec = {
  encode: (err) => ({
    name: err instanceof Error ? err.name : 'Error',
    message: err instanceof Error ? err.message : String(err),
  }),
  decode: (stored) => {
    const e = new Error(stored.message);
    e.name = stored.name;
    return e;
  },
};

export interface DriftInfo {
  readonly agent: string;
  readonly key: string;
  readonly recorded: string;
  readonly current: string;
}

export interface AgentRunOperationOptions {
  readonly name?: string;
  /** Directory (relative to the store) holding one `<key>.json` per run. */
  readonly dir: string;
  key(req: AgentRunRequest): string;
  readonly errors?: ErrorCodec;
  /** Something human for the miss error; the key by default. */
  describe?(req: AgentRunRequest): string;
  /**
   * A hit whose prompt digest no longer matches: the fixture was recorded with
   * a different model or system prompt. Default warns; a CI suite may throw.
   */
  onDrift?(info: DriftInfo): void;
}

export interface AgentRunOperation extends Operation<AgentRunRequest, AgentRunRecord> {
  readonly errors: ErrorCodec;
  key(req: AgentRunRequest): string;
}

/** Digest of what a key may leave out on purpose: the model and the system prompt. */
export function promptDigest(req: Pick<AgentRunRequest, 'model' | 'system'>): string {
  return hashChunks([req.model, req.system]);
}

/**
 * One file per run under `dir`, written atomically, so parallel runs never
 * clobber each other and a recording can be read and edited by hand (a
 * hand-written failure — a truncated answer, an exhausted budget — is a
 * record like any other).
 */
export function agentRunOperation(o: AgentRunOperationOptions): AgentRunOperation {
  const name = o.name ?? 'agent-run';
  const errors = o.errors ?? plainErrorCodec;
  const onDrift =
    o.onDrift ??
    ((info: DriftInfo) =>
      console.warn(
        `[llm-replay] ${name} fixture ${info.key} for "${info.agent}" was recorded with a different model or system prompt`,
      ));
  const file = (req: AgentRunRequest): string => `${o.dir}/${o.key(req)}.json`;
  const describe = o.describe ?? ((req: AgentRunRequest) => `${req.agent} ${o.key(req)}`);
  return {
    name,
    errors,
    key: o.key,
    describe,
    record(req, record, store) {
      store.writeJson(file(req), record);
    },
    replay(req, store) {
      const path = file(req);
      if (!store.has(path)) return undefined;
      const record = store.readJson<AgentRunRecord | null>(path, null);
      if (record === null) throw new Error(`[llm-replay] ${name} fixture ${path} is not valid JSON`);
      const current = promptDigest(req);
      if (record.promptDigest !== current) {
        onDrift({ agent: req.agent, key: o.key(req), recorded: record.promptDigest, current });
      }
      return record;
    },
  };
}

export function okRecord(req: AgentRunRequest, outcome: AgentRunOutcome): AgentRunRecord {
  return {
    outcome: 'ok',
    agent: req.agent,
    model: req.model,
    promptDigest: promptDigest(req),
    recordedAt: new Date().toISOString(),
    text: outcome.text,
    usage: outcome.usage,
    effects: outcome.effects,
  };
}

export function errorRecord(
  req: AgentRunRequest,
  error: SerializedError,
  partial: Partial<AgentRunOutcome> = {},
): AgentRunRecord {
  return {
    outcome: 'error',
    agent: req.agent,
    model: req.model,
    promptDigest: promptDigest(req),
    recordedAt: new Date().toISOString(),
    text: partial.text ?? '',
    usage: partial.usage ?? null,
    effects: partial.effects ?? [],
    error,
  };
}

/**
 * Run the real thing and record whatever comes out — the answer, or the
 * failure (encoded by the operation's codec and rethrown unchanged). `effects`
 * is read AFTER the run so a project can fill it as the run goes; `ofError`
 * tells what a failed run still produced (text streamed before a cut, usage
 * the error carries), so a replayed failure looks like the live one.
 */
export async function recordAgentRun<T>(
  op: AgentRunOperation,
  req: AgentRunRequest,
  store: FixtureStore,
  run: () => Promise<T>,
  pick: (result: T) => AgentRunOutcome,
  effects: () => readonly AgentEffect[] = () => [],
  ofError: (err: unknown) => Partial<AgentRunOutcome> = () => ({}),
): Promise<T> {
  let result: T;
  try {
    result = await run();
  } catch (err: unknown) {
    const encoded = op.errors.encode(err);
    if (encoded !== undefined) {
      recordOperation(op, req, errorRecord(req, encoded, { ...ofError(err), effects: effects() }), store);
    }
    throw err;
  }
  recordOperation(op, req, okRecord(req, { ...pick(result), effects: effects() }), store);
  return result;
}

/**
 * Serve the recorded run. A miss rejects like a failed API call would (or
 * answers through `onMiss`); a recorded failure is returned as a record with
 * `outcome: 'error'` — apply its effects first, then throw
 * `recordedError(op, record)`, so a replayed failure fails at the same point
 * the live one did.
 */
export function replayAgentRun(op: AgentRunOperation, req: AgentRunRequest, store: FixtureStore): AgentRunRecord {
  return replayOperation(op, req, store);
}

/** The project error a failed record stands for. Throws if the record is not a failure. */
export function recordedError(op: AgentRunOperation, record: AgentRunRecord): Error {
  if (record.outcome !== 'error' || record.error === undefined) {
    throw new Error(`[llm-replay] ${op.name} record for "${record.agent}" is not a failure`);
  }
  return op.errors.decode(record.error);
}

export { MissingFixtureError };
