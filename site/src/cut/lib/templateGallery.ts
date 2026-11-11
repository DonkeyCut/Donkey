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
  /** Changes whenever the template is republished, so cached bytes turn over. */
  version: string;
};

export type TemplateIndex = { templates: GalleryTemplate[] };

/** The API the gallery is served from. */
export const TEMPLATES_API = "/api/templates";

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

export type TemplateFilter = {
  category?: TemplateCategory;
  aspect?: TemplateAspect;
  length?: TemplateLength;
  style?: TemplateStyle;
};

export function filterTemplates(all: readonly GalleryTemplate[], f: TemplateFilter): GalleryTemplate[] {
  return all.filter(
    (t) =>
      (!f.category || t.category === f.category) &&
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

/** The template's public page. */
export function templatePage(id: string): string {
  return `/templates/${encodeURIComponent(id)}`;
}
