import { hashChunks } from './hash.js';

/**
 * Markers for the parts of a prompt that change from run to run (ids, dates,
 * paths, a freshly generated diff) and must not take part in the fixture key.
 * HTML comments: invisible in rendered markdown and ignored by models, so the
 * marked prompt can go to the live API unchanged.
 */
export const VOLATILE_OPEN = '<!-- replay:volatile -->';
export const VOLATILE_CLOSE = '<!-- /replay:volatile -->';

/** Wrap a block so `stripVolatile` drops it. Empty input stays empty. */
export function markVolatile(text: string): string {
  return text === '' ? '' : `${VOLATILE_OPEN}${text}${VOLATILE_CLOSE}`;
}

/** Remove every marked span, markers included. Unbalanced markers are left as is. */
export function stripVolatile(text: string): string {
  let out = '';
  let from = 0;
  for (;;) {
    const open = text.indexOf(VOLATILE_OPEN, from);
    if (open === -1) break;
    const close = text.indexOf(VOLATILE_CLOSE, open + VOLATILE_OPEN.length);
    if (close === -1) break;
    out += text.slice(from, open);
    from = close + VOLATILE_CLOSE.length;
  }
  return out + text.slice(from);
}

/** Key of texts with their volatile spans removed, in order. */
export function hashStable(...texts: readonly string[]): string {
  return hashChunks(texts.map(stripVolatile));
}
