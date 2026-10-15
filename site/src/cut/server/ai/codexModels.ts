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
