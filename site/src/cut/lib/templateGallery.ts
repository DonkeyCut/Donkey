// The template gallery: ready-made projects every account can start from.
//
// Templates are assets Donkey keeps in its own storage, never in the source
// tree: each one is a project document and its media under one R2 prefix, and
// an index beside them lists every published template with its name and
// description in each language. The site serves that index and each
// template's document and media read-only (server/cloud/templates.ts); this
// module holds the vocabulary the gallery filters by and the helpers both the
// page and the assistant read the index with.
import type { Locale } from "@/i18n/locales";
import type { ErrorBody } from "./userError";

export const TEMPLATE_CATEGORIES = [
  "opener",
  "promo",
  "slideshow",
  "announcement",
  "countdown",
  "lifestyle",
  "travel",
  "food",
  "fitness",
  "quote",
  "talkingHead",
  "event",
  "celebration",
  "product",
  "explainer",
  "design",
  "titles",
  "logo",
  "trailer",
  "realEstate",
] as const;
export type TemplateCategory = (typeof TEMPLATE_CATEGORIES)[number];

/** Frame shapes, in the order the filter lists them. */
export const TEMPLATE_ASPECTS = ["9:16", "1:1", "4:5", "16:9"] as const;
export type TemplateAspect = (typeof TEMPLATE_ASPECTS)[number];

export const TEMPLATE_STYLES = ["bold", "minimal", "cinematic", "playful", "retro", "elegant"] as const;
export type TemplateStyle = (typeof TEMPLATE_STYLES)[number];

/** Length bands the filter offers. */
export const TEMPLATE_LENGTHS = ["short", "medium", "long"] as const;
export type TemplateLength = (typeof TEMPLATE_LENGTHS)[number];
const SHORT_MAX_S = 15;
const MEDIUM_MAX_S = 30;

/** How many entries one template_gallery page carries by default, and at most. */
export const TEMPLATE_PAGE_DEFAULT = 25;
export const TEMPLATE_PAGE_MAX = 100;

/** What a chat's template_gallery lists: every template, or the starred. */
export const GALLERY_SOURCES = ["all", "favorites"] as const;
export type GallerySource = (typeof GALLERY_SOURCES)[number];

/** Where a chat's template_use puts a template. */
export const TEMPLATE_TARGETS = ["new_project", "timeline"] as const;
export type TemplateTarget = (typeof TEMPLATE_TARGETS)[number];

/** Each aspect's frame in pixels, the size a template is built at. */
export const ASPECT_FRAME: Record<TemplateAspect, { width: number; height: number }> = {
  "9:16": { width: 1080, height: 1920 },
  "1:1": { width: 1080, height: 1080 },
  "4:5": { width: 1080, height: 1350 },
  "16:9": { width: 1920, height: 1080 },
};

/** Text written per language; English is always there. */
export type LocalizedText = { en: string } & Partial<Record<Locale, string>>;

export type GalleryTemplate = {
  id: string;
  name: LocalizedText;
  description: LocalizedText;
  category: TemplateCategory;
  /** Further categories the template is listed under, e.g. a design lesson
   * told on camera sits in talkingHead and design. */
  alsoIn?: TemplateCategory[];
  aspect: TemplateAspect;
  style: TemplateStyle;
  seconds: number;
  fps: number;
  /** Footage clips a person fills with their own media. */
  slots: number;
  /** Titles and captions a person rewrites. */
  texts: number;
  /** Whether a soundtrack plays under it. */
  music?: boolean;
  /** Keywords search reads beside the name and description, in English. */
  tags?: string[];
  /** Changes whenever the template is republished, so cached bytes turn over. */
  version: string;
};

export type TemplateIndex = { templates: GalleryTemplate[] };

/** The API the gallery is served from. */
export const TEMPLATES_API = "/api/templates";

// Search: a description in the searcher's own words, judged against every
// template (server/cloud/templateSearch.ts). The page may send its own
// templates along, each as an id and how it reads.
export const TEMPLATE_SEARCH_ID = "search";
export const TEMPLATE_SEARCH_API = `${TEMPLATES_API}/${TEMPLATE_SEARCH_ID}`;
export const TEMPLATE_QUERY_MAX = 300;
export const TEMPLATE_OWN_MAX = 200;
export type TemplateCandidate = { id: string; label: string };
export type TemplateMatch = { id: string; fit: number };

// Favorites: the gallery templates a person starred, kept on their account.
export const TEMPLATE_FAVORITES_API = `${TEMPLATES_API}/favorites`;
export const templateFavoriteApi = (id: string) => `${TEMPLATES_API}/${encodeURIComponent(id)}/favorite`;
export const FAVORITE_MARKS = ["add", "remove"] as const;
export type FavoriteMark = (typeof FAVORITE_MARKS)[number];

// A template copy into the cloud answers as JSON lines with this type when
// the client asks for its progress: counts of files copied, then the project
// or the failure.
export const COPY_PROGRESS_TYPE = "application/x-ndjson";
export type CopyProgressLine =
  | { done: number; total: number }
  | { projectId: string }
  | ErrorBody;

export function localized(text: LocalizedText, locale: string): string {
  return text[locale as Locale] ?? text.en;
}

/** The length band a template's running time falls in. */
export function lengthOf(seconds: number): TemplateLength {
  if (seconds <= SHORT_MAX_S) {
    return "short";
  }
  if (seconds <= MEDIUM_MAX_S) {
    return "medium";
  }
  return "long";
}

/** Every category a template is listed under, its own first. */
export function categoriesOf(t: GalleryTemplate): TemplateCategory[] {
  return [t.category, ...(t.alsoIn ?? [])];
}

/** The starred items first, the latest star leading, then the rest in their
 * own order. `starred` lists ids newest first, e.g. ["b", "d"] turns
 * [a, b, c, d] into [b, d, a, c]. */
export function favoritesFirst<T>(items: readonly T[], idOf: (item: T) => string, starred: Iterable<string> | null): T[] {
  const rank = new Map([...(starred ?? [])].map((id, i) => [id, i]));
  const top = items.filter((i) => rank.has(idOf(i))).sort((a, b) => rank.get(idOf(a))! - rank.get(idOf(b))!);
  return [...top, ...items.filter((i) => !rank.has(idOf(i)))];
}

/** The starred ids, newest first, after one star goes on or comes off. */
export function withFavorite(ids: readonly string[], id: string, mark: FavoriteMark): string[] {
  if (mark === "remove") {
    return ids.filter((x) => x !== id);
  }
  return ids.includes(id) ? [...ids] : [id, ...ids];
}

export type TemplateFilter = {
  category?: TemplateCategory;
  aspect?: TemplateAspect;
  length?: TemplateLength;
  style?: TemplateStyle;
};

export function filterTemplates(all: readonly GalleryTemplate[], f: TemplateFilter): GalleryTemplate[] {
  return all.filter(
    (t) =>
      (!f.category || categoriesOf(t).includes(f.category)) &&
      (!f.aspect || t.aspect === f.aspect) &&
      (!f.length || lengthOf(t.seconds) === f.length) &&
      (!f.style || t.style === f.style)
  );
}

/** Up to `count` other templates in the same category, same-aspect ones
 * first, for the detail page's "Similar" row. */
export function similarTemplates(all: readonly GalleryTemplate[], id: string, count: number): GalleryTemplate[] {
  const self = all.find((t) => t.id === id);
  if (!self) {
    return [];
  }
  const peers = all.filter((t) => t.id !== id && t.category === self.category);
  const sameShape = peers.filter((t) => t.aspect === self.aspect);
  const otherShape = peers.filter((t) => t.aspect !== self.aspect);
  return [...sameShape, ...otherShape].slice(0, count);
}

// Page numbers the gallery's page bar shows on each side of the current one.
const PAGE_REACH = 1;

/** The page numbers the bar shows: the first, the last, and the ones around
 * the current page, with null where a run is skipped. Page 6 of 10 reads
 * 1 … 5 6 7 … 10. */
export function pageWindow(page: number, pages: number): (number | null)[] {
  const out: (number | null)[] = [];
  for (let n = 1; n <= pages; n++) {
    const near = Math.abs(n - page) <= PAGE_REACH;
    if (n === 1 || n === pages || near) {
      out.push(n);
      continue;
    }
    if (out[out.length - 1] !== null) {
      out.push(null);
    }
  }
  return out;
}

const templatePath = (id: string) => `${TEMPLATES_API}/${encodeURIComponent(id)}`;

/** A template's still card. */
export function templatePoster(t: GalleryTemplate): string {
  return `${templatePath(t.id)}/poster?v=${encodeURIComponent(t.version)}`;
}

/** A video clip's first frame, baked at publish for the template page's
 * timeline. */
export function templateFrame(t: Pick<GalleryTemplate, "id" | "version">, clipId: string): string {
  return `${templatePath(t.id)}/frames/${encodeURIComponent(clipId)}?v=${encodeURIComponent(t.version)}`;
}

/** The waveform peaks baked at publish for the template page's timeline,
 * keyed by asset id. */
export function templatePeaks(t: Pick<GalleryTemplate, "id" | "version">): string {
  return `${templatePath(t.id)}/peaks?v=${encodeURIComponent(t.version)}`;
}

/** The template's public page. */
export function templatePage(id: string): string {
  return `/templates/${encodeURIComponent(id)}`;
}

/** Whether the gate has answered if this Mac's shelf is in reach. */
export type GateState = "settled" | "unsettled";

/** Whether the person's own templates are still unknown: the gate has yet to
 * say whether this Mac's shelf joins the read, or a shelf has yet to answer.
 * A shelf that fails to answer counts as answered. */
export function ownTemplatesPending(gate: GateState, shelves: { isPending: boolean }[]): boolean {
  return gate === "unsettled" || shelves.some((s) => s.isPending);
}
