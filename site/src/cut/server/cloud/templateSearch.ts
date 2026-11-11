// Template search: a description in the searcher's own words, and the
// templates that fit it. Each template is one typed yes/no to the judge —
// does this one fit what was asked for? — asked in chunks that all go out
// together, so a search over the whole gallery settles in about one request.
// Name, description, category, style, shape, length, music and the template's
// own tags are what the judge reads, so "a warm travel recap with music" and
// "something for a bakery opening" both find their templates.
import { CUT_JUDGE } from "@/cut/lib/chatRuntime";
import { noul, type Entry, type NoulAnswer } from "@/cut/lib/judge";
import {
  TEMPLATE_OWN_MAX,
  TEMPLATE_QUERY_MAX,
  type GalleryTemplate,
  type TemplateCandidate,
  type TemplateMatch,
} from "@/cut/lib/templateGallery";
import { UserError } from "@/cut/lib/userError";
import { inferenceUsageRoutes, recordInferenceUsage } from "@/lib/credits/inference";
import { getDonkeyAuthContext, shouldBypassDonkeyInferenceCredits, type DonkeyAuthContext } from "@/lib/donkey-api-auth";
import { typesafeJudge } from "@/lib/inference/adapters/typesafe";
import { toJsonValue } from "@/lib/inference/json";
import { checkInMemoryRateLimit, rateLimitResponse } from "@/lib/inference/rate-limit";
import { err } from "./util";

const SIGN_IN = new UserError("template_search_sign_in", "Sign in to search templates.");
const BAD_QUERY = new UserError("template_search_query", "Describe the template you are looking for.");
const UNAVAILABLE = new UserError("template_search_failed", "Template search isn't available right now.");
const HTTP_BAD_GATEWAY = 502;

// Templates per judge request; the chunks go out together.
const SEARCH_CHUNK = 50;

// Searches one account may run a minute. Search is part of the gallery, so
// it spends no credits; its judgments are recorded as included usage.
const SEARCH_PACE = { limit: 30, windowMs: 60_000 };
const SEARCH_CLIENT = "donkey-cut-templates";

// Searches remembered per server instance, keyed by the published versions
// they ran against, so a repeated search answers without a judgment.
const CACHE_MAX = 200;
const cache = new Map<string, TemplateMatch[]>();

const key = (i: number) => `t${i}`;

/** How a gallery template reads to the judge. */
function galleryLabel(t: GalleryTemplate): string {
  const parts = [
    `${t.name.en}: ${t.description.en}`,
    `category ${t.category}`,
    `style ${t.style}`,
    `frame ${t.aspect}`,
    `${t.seconds}s long`,
    `${t.slots} footage slots`,
    `${t.texts} texts`,
    t.music ? "has music" : "no music",
  ];
  if (t.tags?.length) {
    parts.push(`tags: ${t.tags.join(", ")}`);
  }
  return parts.join("; ");
}

/** One yes/no per template: does it fit the search? */
function searchQuestions(count: number) {
  return Object.fromEntries(
    Array.from({ length: count }, (_, i) => [
      key(i),
      noul(`Template \`${key(i)}\` in \`templates\` — does it fit what the person searching describes in \`query\`?`, {
        true: "It is a template the person would want to see for this search: its subject, purpose, look, shape or length matches what they described.",
        false: "It is unrelated to the search, or matches only a word of it and none of what the person meant.",
      }),
    ])
  );
}

/** Every candidate judged: each one's fit, in the candidates' order. Each
 * request's usage is recorded against the searcher. */
async function judgeAll(query: string, labels: string[], caller: DonkeyAuthContext, signal: AbortSignal): Promise<number[]> {
  const judge = typesafeJudge();
  const questions = searchQuestions(labels.length);
  const chunks: number[][] = [];
  for (let i = 0; i < labels.length; i += SEARCH_CHUNK) {
    chunks.push(Array.from({ length: Math.min(SEARCH_CHUNK, labels.length - i) }, (_, n) => i + n));
  }

  // One request per chunk: the query, and the templates that chunk judges.
  const answered = await Promise.all(
    chunks.map(async (chunk) => {
      const state: Entry = {
        query,
        templates: chunk.map((i) => ({ key: key(i), is: labels[i] })),
      };
      const subset = Object.fromEntries(chunk.map((i) => [key(i), questions[key(i)]]));
      const result = await judge.askJudge({ state, questions: subset }, signal);
      await recordSearch(caller, result.model, result.usage);
      return result.answers as Record<string, NoulAnswer | undefined>;
    })
  );
  const all = Object.assign({}, ...answered) as Record<string, NoulAnswer | undefined>;
  return labels.map((_, i) => all[key(i)]?.noul ?? 0);
}

/** One judgment's usage, recorded without a charge. The dev bypass has no
 * account to record against. */
async function recordSearch(caller: DonkeyAuthContext, model: string, usage: unknown): Promise<void> {
  if (shouldBypassDonkeyInferenceCredits(caller)) {
    return;
  }
  await recordInferenceUsage({
    userId: caller.userId,
    clientId: SEARCH_CLIENT,
    route: inferenceUsageRoutes.judge,
    requestKind: "template_search",
    provider: typesafeJudge().id,
    model,
    status: "succeeded",
    usage: toJsonValue(usage),
    billingMode: "included",
  });
}

/** The searcher's own templates, as the page sends them: an id and how the
 * template reads. Anything else is dropped. */
function ownFrom(raw: unknown): TemplateCandidate[] {
  if (!Array.isArray(raw)) {
    return [];
  }
  return raw
    .filter((c): c is TemplateCandidate => typeof c?.id === "string" && typeof c?.label === "string")
    .slice(0, TEMPLATE_OWN_MAX)
    .map((c) => ({ id: c.id, label: c.label.slice(0, TEMPLATE_QUERY_MAX) }));
}

/** POST /api/templates/search — { query, own? } → { matches: [{ id, fit }] },
 * best fit first. A signed-in session, the runner or an API key may search;
 * the gallery itself stays public. */
export async function searchTemplates(req: Request, gallery: readonly GalleryTemplate[]): Promise<Response> {
  const caller = await getDonkeyAuthContext(req.headers, { allowRunner: true, allowApiKey: true });
  if (!caller) {
    return err(SIGN_IN, 401);
  }
  const pace = checkInMemoryRateLimit({ key: `template-search:${caller.userId}`, ...SEARCH_PACE });
  if (!pace.ok) {
    return rateLimitResponse(pace.retryAfterSeconds);
  }

  const body = (await req.json().catch(() => null)) as { query?: unknown; own?: unknown } | null;
  const query = typeof body?.query === "string" ? body.query.trim().slice(0, TEMPLATE_QUERY_MAX) : "";
  if (!query) {
    return err(BAD_QUERY, 400);
  }
  const own = ownFrom(body?.own);

  // A search this instance already ran against the same templates answers at once.
  const cacheKey = JSON.stringify([query, own, gallery.map((t) => t.version)]);
  const hit = cache.get(cacheKey);
  if (hit) {
    return Response.json({ matches: hit });
  }

  const candidates: TemplateCandidate[] = [...gallery.map((t) => ({ id: t.id, label: galleryLabel(t) })), ...own];
  try {
    const fits = await judgeAll(query, candidates.map((c) => c.label), caller, req.signal);
    const matches = candidates
      .map((c, i) => ({ id: c.id, fit: Math.round(fits[i] * 1000) / 1000 }))
      .filter((m) => m.fit >= CUT_JUDGE.sweepFit)
      .sort((a, b) => b.fit - a.fit);

    // The oldest search goes when the cache is full.
    cache.set(cacheKey, matches);
    if (cache.size > CACHE_MAX) {
      cache.delete(cache.keys().next().value!);
    }
    return Response.json({ matches });
  } catch {
    return err(UNAVAILABLE, HTTP_BAD_GATEWAY);
  }
}
