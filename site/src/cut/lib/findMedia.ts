/**
 * Finding project media by name. The chat's context snapshot lists only the
 * first `FIND_MEDIA_SNAPSHOT_CAP` media items, so a long project's later
 * imports — a batch of reference images uploaded last — are reached by name
 * through find_media instead.
 */

/** How many media items the context snapshot lists before it trims. */
export const FIND_MEDIA_SNAPSHOT_CAP = 60;

/** How many matches find_media answers with by default, and at most. */
export const FIND_MEDIA_DEFAULT = 50;
export const FIND_MEDIA_MAX = 200;

export type MediaKind = "video" | "image" | "audio";

/** The page of `assets` whose name or file name contains `query` (any case)
 * and, when given, is of `type`; `next` is the offset of the page after,
 * absent on the last. */
export function findMedia<A extends { name: string; fileName: string; type: string }>(
  assets: A[],
  opts: { query?: string; type?: MediaKind; limit?: number; offset?: number }
): { total: number; page: A[]; next?: number } {
  const q = (opts.query ?? "").trim().toLowerCase();
  const hits = assets.filter(
    (a) => (!opts.type || a.type === opts.type) && (!q || a.name.toLowerCase().includes(q) || a.fileName.toLowerCase().includes(q))
  );
  const limit = Math.max(1, Math.min(FIND_MEDIA_MAX, Math.round(opts.limit ?? FIND_MEDIA_DEFAULT)));
  const offset = Math.max(0, Math.round(opts.offset ?? 0));
  const page = hits.slice(offset, offset + limit);
  return offset + limit < hits.length ? { total: hits.length, page, next: offset + limit } : { total: hits.length, page };
}
