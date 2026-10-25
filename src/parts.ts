import type { Part } from './types.js';

/** The text parts of a request joined by newlines — for classifiers and prompt parsers. */
export function textParts(parts: readonly Part[]): string {
  return parts
    .filter((p): p is Extract<Part, { kind: 'text' }> => p.kind === 'text')
    .map((p) => p.text)
    .join('\n');
}
