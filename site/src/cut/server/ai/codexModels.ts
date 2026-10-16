import { z } from "zod";

const catalogSchema = z.object({ models: z.array(z.object({ slug: z.string() })) });

/** The model ids in `codex debug models` output: the catalog Codex serves
 * the signed-in account. Undefined when the output is no catalog (an older
 * CLI without the subcommand, or a failed refresh). */
export function codexAccountModels(stdout: string): string[] | undefined {
  try {
    const parsed = catalogSchema.safeParse(JSON.parse(stdout));
    return parsed.success ? parsed.data.models.map((m) => m.slug) : undefined;
  } catch {
    return undefined;
  }
}

/** How long a read catalog stands before the next ask refreshes it. */
export const CODEX_CATALOG_TTL_MS = 10 * 60_000;

/** The account catalog, read in the background. `current` never waits on
 * `codex debug models` (which can take seconds): it answers with the last
 * catalog read and starts a refresh when that one is stale. A failed read
 * keeps the last catalog. */
export function createCodexCatalog(read: () => Promise<string[] | undefined>, now: () => number = Date.now) {
  let models: string[] | undefined;
  let readAt = -Infinity;
  let reading = false;

  return {
    current(): string[] | undefined {
      if (reading || now() - readAt < CODEX_CATALOG_TTL_MS) {
        return models;
      }

      // One read at a time; the stale catalog answers until it lands.
      reading = true;
      void read().then((next) => {
        if (next) {
          models = next;
        }
        readAt = now();
        reading = false;
      });
      return models;
    },
  };
}
