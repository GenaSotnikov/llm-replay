import { MissingFixtureError } from './errors.js';
import { hashJoined } from './hash.js';
import type { Operation } from './operation.js';
import type { EmbedRequest, EmbedResponse } from './types.js';

export interface EmbeddingOperationOptions {
  /** Directory (relative to the store) of one raw float32 vector per text. */
  readonly dir: string;
  readonly name?: string;
}

/**
 * Embeddings are keyed per text (model + task type + dimensions + text), not
 * per request, so a batch of N texts replays from N files and a text seen in
 * any earlier batch is already covered.
 */
export function embeddingOperation(o: EmbeddingOperationOptions): Operation<EmbedRequest, EmbedResponse> {
  const name = o.name ?? 'embedding';
  const file = (req: EmbedRequest, text: string): string =>
    `${o.dir}/${hashJoined([req.model, req.taskType ?? '', req.dimensions === undefined ? '' : String(req.dimensions), text])}.f32`;

  return {
    name,
    record(req, res, store) {
      if (res.vectors.length !== req.texts.length) return;
      req.texts.forEach((text, i) => {
        const values = res.vectors[i];
        if (!values?.length) return;
        store.writeBinary(file(req, text), Buffer.from(new Float32Array(values).buffer));
      });
    },
    replay(req, store) {
      const vectors = req.texts.map((text) => {
        const path = file(req, text);
        if (!store.has(path)) {
          throw new MissingFixtureError(name, `"${text.slice(0, 40)}"`, store.recordHint);
        }
        const buf = store.readBinary(path);
        return Array.from(new Float32Array(buf.buffer, buf.byteOffset, buf.byteLength / 4));
      });
      return { vectors };
    },
  };
}
