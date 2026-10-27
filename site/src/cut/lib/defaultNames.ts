import { createTranslator } from "use-intl/core";

import english from "@/i18n/messages/en/errors.json";
import { DEFAULT_LOCALE, isLocale, type Locale } from "@/i18n/locales";
import { translatorFor } from "@/i18n/translator";

// The names the product writes into a person's project when they gave none:
// a project or note called "Untitled", a new title reading "Your text", a
// still named "Frame 0:12". They are content, so they are written in the
// language of the person who created them and stay that way. The catalog is
// `errors.defaults` (messages/<locale>/errors.json).
//
// Two ways in. A request handler (engine, cloud route) knows its caller's
// locale and asks `defaultNames(locale)`. Code that runs inside one person's
// session (the page, a headless turn) binds that person's locale once and
// reads `creatorNames()` synchronously, the way it reads the editor store.

export interface DefaultNames {
  untitled: string;
  text: string;
  /** A still's name for the timecode it was taken at, e.g. "Frame 0:12". */
  frame: (time: string) => string;
  /** A duplicate's name, e.g. "Trip copy". */
  copy: (name: string) => string;
}

type DefaultsTranslator = (
  key: "untitled" | "text" | "frame" | "copy",
  values?: { time: string } | { name: string },
) => string;

const namesFrom = (t: DefaultsTranslator): DefaultNames => ({
  untitled: t("untitled"),
  text: t("text"),
  frame: (time) => t("frame", { time }),
  copy: (name) => t("copy", { name }),
});

// English ships in every bundle, so the sync read always has names.
const ENGLISH = namesFrom(
  createTranslator({ locale: DEFAULT_LOCALE, messages: { errors: english }, namespace: "errors.defaults" }),
);

const loaded = new Map<Locale, DefaultNames>([[DEFAULT_LOCALE, ENGLISH]]);
let bound: Locale = DEFAULT_LOCALE;

/** The locale a request named, e.g. a create body's `locale`; the default
 * when it named none the catalog has. */
export const requestedLocale = (value: unknown): Locale => (isLocale(value) ? value : DEFAULT_LOCALE);

/** The default names in one locale's words. */
export async function defaultNames(locale: Locale): Promise<DefaultNames> {
  const hit = loaded.get(locale);
  if (hit) {
    return hit;
  }
  const t = await translatorFor(locale, "errors");
  const names = namesFrom((key, values) => t(`defaults.${key}`, values));
  loaded.set(locale, names);
  return names;
}

/** Name what this session creates in `locale` from now on: the page binds
 * the language it draws in, a headless turn the language of its request.
 * Settles once that language's names have loaded. */
export async function bindCreatorLocale(locale: Locale): Promise<void> {
  bound = locale;
  await defaultNames(locale);
}

/** The locale the session bound, for a request that carries it onward. */
export const creatorLocale = (): Locale => bound;

/** The bound locale's default names. English until its catalog has loaded,
 * a moment after the bind. */
export const creatorNames = (): DefaultNames => loaded.get(bound) ?? ENGLISH;
