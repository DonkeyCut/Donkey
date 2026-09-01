// PostHog read access for the analytics pipeline. Browser ingestion uses the
// public project key against us.i.posthog.com; these reads go through the
// query API on the main host, addressed by POSTHOG_PROJECT_ID and authorized
// by POSTHOG_PERSONAL_API_KEY — both env, and both required before any
// PostHog extraction runs.
import { addUtcDays } from "@/lib/analytics/schema";

const POSTHOG_HOST = "https://us.posthog.com";

/** A POSTHOG_PROJECT_ID that is not a project id. Permanent: no retry fixes a
 * bad env value. */
export class PosthogConfigError extends Error {}

// The numeric project id from PostHog → Settings → Project. Unset leaves this
// deployment without PostHog. A malformed value raises: a typo here once cost
// the pipeline months of PostHog data while every run reported success.
function posthogProjectId(): number | undefined {
  const raw = process.env.POSTHOG_PROJECT_ID?.trim();
  if (!raw) return undefined;
  const id = Number(raw);
  if (!Number.isInteger(id) || id <= 0) {
    throw new PosthogConfigError(
      `POSTHOG_PROJECT_ID must be the numeric project id from PostHog → Settings → Project; got "${raw}".`,
    );
  }
  return id;
}

export function isPosthogQueryConfigured(): boolean {
  return posthogProjectId() !== undefined && Boolean(process.env.POSTHOG_PERSONAL_API_KEY);
}

/** distinct_ids that fired app_loaded during the UTC day. app_loaded fires
 * only after posthog.identify(user.id), so these are app user ids plus
 * whatever anonymous ids a shared browser aliased in. */
export async function fetchActiveDistinctIds(day: string): Promise<string[]> {
  const apiKey = process.env.POSTHOG_PERSONAL_API_KEY;
  const projectId = posthogProjectId();
  if (!apiKey || projectId === undefined) {
    throw new Error("PostHog query access is not configured.");
  }
  const query = [
    "SELECT DISTINCT distinct_id FROM events",
    "WHERE event = 'app_loaded'",
    `AND timestamp >= toDateTime('${day} 00:00:00', 'UTC')`,
    `AND timestamp < toDateTime('${addUtcDays(day, 1)} 00:00:00', 'UTC')`,
    "LIMIT 10000",
  ].join(" ");
  const res = await fetch(`${POSTHOG_HOST}/api/projects/${projectId}/query`, {
    body: JSON.stringify({ query: { kind: "HogQLQuery", query } }),
    headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
    method: "POST",
  });
  if (!res.ok) {
    const detail = (await res.text().catch(() => "")).slice(0, 300);
    throw new Error(`PostHog query failed (${res.status}): ${detail}`);
  }
  const data = (await res.json()) as { results?: unknown[][] };
  const ids = new Set<string>();
  for (const row of data.results ?? []) {
    const id = row?.[0];
    if (typeof id === "string" && id) ids.add(id);
  }
  return [...ids].sort();
}
