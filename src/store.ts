import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

export interface FixtureStoreOptions {
  /** Appended to every missing-fixture error: how to record one in this project. */
  readonly recordHint?: string;
}

/**
 * A directory of fixtures. JSON maps hold many small answers per file; big or
 * binary answers (images, vectors) get one file each. Paths are relative to
 * `root`, so a project can point the store at a temp dir in its tests.
 */
export class FixtureStore {
  readonly recordHint: string;

  constructor(
    readonly root: string,
    options: FixtureStoreOptions = {},
  ) {
    this.recordHint = options.recordHint ?? 'record it first';
  }

  path(relative: string): string {
    return join(this.root, relative);
  }

  has(relative: string): boolean {
    return existsSync(this.path(relative));
  }

  readJson<T>(relative: string, fallback: T): T {
    try {
      return JSON.parse(readFileSync(this.path(relative), 'utf8')) as T;
    } catch {
      return fallback;
    }
  }

  writeJson(relative: string, value: unknown): void {
    const file = this.path(relative);
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`);
  }

  /** Read-modify-write of one JSON file. */
  updateJson<T>(relative: string, fallback: T, mutate: (value: T) => void): void {
    const value = this.readJson(relative, fallback);
    mutate(value);
    this.writeJson(relative, value);
  }

  readBinary(relative: string): Buffer {
    return readFileSync(this.path(relative));
  }

  writeBinary(relative: string, data: Buffer): void {
    const file = this.path(relative);
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, data);
  }
}
