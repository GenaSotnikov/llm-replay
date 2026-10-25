import type { ReplayMode } from './types.js';

const MODES: readonly ReplayMode[] = ['off', 'record', 'replay'];

/**
 * Parse the mode switch (`LLM_REPLAY=off|record|replay` by convention). Unset
 * or empty means `off`; anything else that is not a mode is a configuration
 * error and throws, so a typo cannot silently run the suite against the live
 * API.
 */
export function parseReplayMode(raw: string | undefined, envName = 'LLM_REPLAY'): ReplayMode {
  const value = (raw ?? '').trim();
  if (value === '') return 'off';
  if ((MODES as readonly string[]).includes(value)) return value as ReplayMode;
  throw new Error(`[llm-replay] ${envName}="${raw}" is not a mode (expected ${MODES.join(' | ')})`);
}
