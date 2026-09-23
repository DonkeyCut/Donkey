import { afterAll, mock } from "bun:test";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";

declare const Bun: { resolveSync(specifier: string, from: string): string };

/**
 * Stand in for some of a module's exports for the test file that calls this.
 *
 * Bun runs every test file in one process, and a module mock rewrites the
 * loaded module for every file that runs after it, so the order the files
 * run in on one machine decides what another machine's suite reads. The
 * originals are copied before the mock goes in and put back once this file's
 * tests are done. `from` is the caller's `import.meta.url`; the specifier
 * resolves against it the way an import from that file would.
 */
export async function stubModule<T extends object>(
  specifier: string,
  from: string,
  overrides: Partial<T>,
): Promise<T> {
  const path = Bun.resolveSync(specifier, dirname(fileURLToPath(from)));
  const real = { ...((await import(path)) as T) };
  mock.module(path, () => ({ ...real, ...overrides }));
  afterAll(() => {
    mock.module(path, () => real);
  });
  return real;
}
