/** Thrown on replay when nothing was recorded for a request. */
export class MissingFixtureError extends Error {
  constructor(
    readonly operation: string,
    detail: string,
    hint: string,
  ) {
    super(`[llm-replay] no ${operation} fixture for ${detail} — ${hint}`);
    this.name = 'MissingFixtureError';
  }
}
