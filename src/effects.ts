/**
 * Side effects of an agent run: calls the model made into the project's
 * bridges (write a document, delegate a task, run a command in the sandbox).
 * They are recorded as data and re-applied on replay through the SAME bridges,
 * so the system — not the fixture — decides what each call does.
 */

/** Method name recorded when the bridge itself is the function being called. */
export const CALLABLE = '()';

export interface AgentEffect {
  /** Which bridge, as named by the project (`sandbox`, `documents`, …). */
  readonly bridge: string;
  /** Method called on the bridge, or `CALLABLE` for a bridge that is a function. */
  readonly method: string;
  /** Arguments as passed; must be JSON-serialisable. */
  readonly args: readonly unknown[];
  /** The bridge's answer during the recording, for inspection only. */
  readonly result?: unknown;
  /** The bridge threw this message during the recording. */
  readonly error?: string;
}

type AnyFn = (...args: unknown[]) => unknown;

const settle = (log: AgentEffect[], entry: Omit<AgentEffect, 'result' | 'error'>, outcome: unknown): unknown => {
  if (outcome instanceof Promise) {
    return outcome.then(
      (result) => {
        log.push({ ...entry, result });
        return result;
      },
      (err: unknown) => {
        log.push({ ...entry, error: err instanceof Error ? err.message : String(err) });
        throw err;
      },
    );
  }
  log.push({ ...entry, result: outcome });
  return outcome;
};

/**
 * A bridge that behaves exactly like `target` and appends every call to `log`
 * in call order (completion order for async calls). Works for objects with
 * methods and for bare functions. Non-function properties are passed through.
 */
export function recordingProxy<T extends object>(target: T, bridge: string, log: AgentEffect[]): T {
  if (typeof target === 'function') {
    const fn = target as unknown as AnyFn;
    return ((...args: unknown[]) => settle(log, { bridge, method: CALLABLE, args }, fn(...args))) as unknown as T;
  }
  return new Proxy(target, {
    get(obj, prop, receiver) {
      const value = Reflect.get(obj, prop, receiver) as unknown;
      if (typeof value !== 'function' || typeof prop !== 'string') return value;
      const method = value as AnyFn;
      return (...args: unknown[]) => settle(log, { bridge, method: prop, args }, method.apply(obj, args));
    },
  });
}

export interface ApplyEffectsOptions {
  /** A recorded effect whose bridge the caller did not provide: fail (default) or skip. */
  readonly missingBridge?: 'throw' | 'skip';
}

/**
 * Re-apply recorded effects, in order and one at a time, through the bridges
 * the caller provides under the same names. A bridge error propagates — the
 * replayed run then fails where the recorded one would have.
 */
export async function applyEffects(
  effects: readonly AgentEffect[],
  bridges: Readonly<Record<string, object | undefined>>,
  options: ApplyEffectsOptions = {},
): Promise<void> {
  for (const effect of effects) {
    const bridge = bridges[effect.bridge];
    if (bridge === undefined) {
      if (options.missingBridge === 'skip') continue;
      throw new Error(`[llm-replay] recorded effect needs bridge "${effect.bridge}", which the caller did not provide`);
    }
    if (effect.method === CALLABLE) {
      if (typeof bridge !== 'function') {
        throw new Error(`[llm-replay] recorded effect calls bridge "${effect.bridge}" as a function, but it is not one`);
      }
      await (bridge as AnyFn)(...effect.args);
      continue;
    }
    const method = (bridge as Record<string, unknown>)[effect.method];
    if (typeof method !== 'function') {
      throw new Error(`[llm-replay] recorded effect calls "${effect.bridge}.${effect.method}", which the bridge does not have`);
    }
    await (method as AnyFn).apply(bridge, [...effect.args]);
  }
}
