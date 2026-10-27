// Translates the English UI catalogs into every other shipped locale.
//
//   bun scripts/i18n-translate.ts                # every catalog that needs it
//   bun scripts/i18n-translate.ts --check        # fail if anything is stale
//   bun scripts/i18n-translate.ts --native-only  # only the Mac and iOS apps' catalogs
//
// English is the source. A key is (re)translated when its locale lacks it or
// when its English changed since it was translated: the lock file beside the
// catalogs records the English each translation was made from. Keys gone from
// English are deleted everywhere. Each translation must take exactly the ICU
// arguments, plurals and tags its English takes; one that doesn't is retried
// once and then fails the run.
//
// Catalogs: the site's (src/i18n/messages/<locale>/<namespace>.json), any
// directory passed with --dir laid out the same way (the back office's email
// catalogs), and the native apps' String Catalogs (apps/**/*.xcstrings) and
// en.lproj .strings files (the iOS Settings bundle). Native strings carry
// printf specifiers (%@, %lld, %1$@) in place of ICU arguments, and the same
// retry-then-fail check holds them to their English.

import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { GoogleGenAI, Type } from "@google/genai";
import { TYPE, parse, type MessageFormatElement } from "@formatjs/icu-messageformat-parser";

import { LOCALES, LOCALE_NAMES, type Locale } from "../src/i18n/locales";
import { geminiClientConfig } from "../src/lib/inference/adapters/gemini-client";
import { geminiModels } from "../src/lib/inference/gemini-models";

const SITE_MESSAGES = path.join(import.meta.dirname, "..", "src", "i18n", "messages");
const LOCK_FILE = ".source-lock.json";
const BATCH_SIZE = 30;
const CONCURRENCY = 6;

// Names and terms that stay as they are in every language.
const GLOSSARY = [
  "Donkey, Donkey Cut, Donkey Inc.: product and company names, never translated",
  "Pro: the paid plan's name, never translated",
  "Claude, Codex, ChatGPT, Gemini, GitHub, Discord, Google, Apple, Stripe, YouTube, TikTok, Pexels, ElevenLabs: never translated",
  "Mac, macOS, iPhone, iOS: never translated",
  "Keyboard shortcuts such as ⌘J, ⇧⌘Z, Space, Esc, Enter, Delete, ⌫ keep their symbols and key names",
  "File formats and units (MP4, MOV, ProRes, SRT, LUT, 4K, 1080p, fps, dB, Hz, px, MB, GB) stay as they are",
];

type Target = Exclude<Locale, "en">;

// Editing terms and the one word each language uses for each, so a term reads
// the same on every screen. The sense says which meaning of the English the
// word stands for; the same English in another sense translates freely.
const TERMS: { english: string; sense: string; words: Record<Target, string> }[] = [
  {
    english: "Export",
    sense: "render the project to a video file",
    words: { es: "Exportar", "pt-BR": "Exportar", fr: "Exporter", de: "Exportieren", ja: "書き出し", ko: "내보내기", "zh-CN": "导出" },
  },
  {
    english: "Share",
    sense: "give other people a link",
    words: { es: "Compartir", "pt-BR": "Compartilhar", fr: "Partager", de: "Teilen", ja: "共有", ko: "공유", "zh-CN": "分享" },
  },
  {
    english: "Split",
    sense: "cut a clip in two at the playhead",
    words: { es: "Dividir", "pt-BR": "Dividir", fr: "Scinder", de: "Trennen", ja: "分割", ko: "분할", "zh-CN": "分割" },
  },
  {
    english: "Trim",
    sense: "shorten a clip from its start or end",
    words: { es: "Recortar", "pt-BR": "Aparar", fr: "Rogner", de: "Trimmen", ja: "トリム", ko: "트리밍", "zh-CN": "修剪" },
  },
  {
    english: "Library",
    sense: "the person's collection of media and assets",
    words: { es: "Biblioteca", "pt-BR": "Biblioteca", fr: "Bibliothèque", de: "Mediathek", ja: "ライブラリ", ko: "라이브러리", "zh-CN": "素材库" },
  },
  {
    english: "Notes",
    sense: "the written notes and scripts the person keeps",
    words: { es: "Notas", "pt-BR": "Notas", fr: "Notes", de: "Notizen", ja: "ノート", ko: "메모", "zh-CN": "笔记" },
  },
  {
    english: "Blur",
    sense: "soften the picture",
    words: { es: "Desenfoque", "pt-BR": "Desfoque", fr: "Flou", de: "Weichzeichner", ja: "ブラー", ko: "블러", "zh-CN": "模糊" },
  },
  {
    english: "Feather",
    sense: "soften the edge of a mask or shape",
    words: { es: "Calado", "pt-BR": "Difusão", fr: "Contour progressif", de: "Weiche Kante", ja: "フェザー", ko: "페더", "zh-CN": "羽化" },
  },
  {
    english: "Timeline",
    sense: "where clips are arranged in time",
    words: { es: "Línea de tiempo", "pt-BR": "Linha do tempo", fr: "Timeline", de: "Timeline", ja: "タイムライン", ko: "타임라인", "zh-CN": "时间线" },
  },
  {
    english: "Clip",
    sense: "a piece of media placed on the timeline",
    words: { es: "Clip", "pt-BR": "Clipe", fr: "Clip", de: "Clip", ja: "クリップ", ko: "클립", "zh-CN": "片段" },
  },
  {
    english: "Track",
    sense: "a horizontal lane of the timeline",
    words: { es: "Pista", "pt-BR": "Faixa", fr: "Piste", de: "Spur", ja: "トラック", ko: "트랙", "zh-CN": "轨道" },
  },
  {
    english: "Title",
    sense: "text placed over the video",
    words: { es: "Título", "pt-BR": "Título", fr: "Titre", de: "Titel", ja: "タイトル", ko: "타이틀", "zh-CN": "标题" },
  },
  {
    english: "Subtitles",
    sense: "timed captions of what is said",
    words: { es: "Subtítulos", "pt-BR": "Legendas", fr: "Sous-titres", de: "Untertitel", ja: "字幕", ko: "자막", "zh-CN": "字幕" },
  },
  {
    english: "Transition",
    sense: "the blend from one clip into the next",
    words: { es: "Transición", "pt-BR": "Transição", fr: "Transition", de: "Übergang", ja: "トランジション", ko: "전환", "zh-CN": "转场" },
  },
  {
    english: "Effect",
    sense: "a visual effect applied to a clip",
    words: { es: "Efecto", "pt-BR": "Efeito", fr: "Effet", de: "Effekt", ja: "エフェクト", ko: "효과", "zh-CN": "特效" },
  },
  {
    english: "Keyframe",
    sense: "a value pinned at a moment of an animation",
    words: { es: "Fotograma clave", "pt-BR": "Quadro-chave", fr: "Image clé", de: "Keyframe", ja: "キーフレーム", ko: "키프레임", "zh-CN": "关键帧" },
  },
  {
    english: "Playhead",
    sense: "the marker of the current time on the timeline",
    words: { es: "Cabezal de reproducción", "pt-BR": "Indicador de reprodução", fr: "Tête de lecture", de: "Abspielposition", ja: "再生ヘッド", ko: "재생헤드", "zh-CN": "播放头" },
  },
  {
    english: "Fade",
    sense: "one word for both fading in and fading out",
    words: { es: "Fundido", "pt-BR": "Fade", fr: "Fondu", de: "Blende", ja: "フェード", ko: "페이드", "zh-CN": "淡化" },
  },
  {
    english: "Roll",
    sense: "the camera turning around its forward axis, beside pan and tilt",
    words: { es: "Alabeo", "pt-BR": "Rolamento", fr: "Roulis", de: "Rollen", ja: "ロール", ko: "롤", "zh-CN": "横滚" },
  },
  {
    english: "Media",
    sense: "imported video, audio and images",
    words: { es: "Multimedia", "pt-BR": "Mídia", fr: "Médias", de: "Medien", ja: "メディア", ko: "미디어", "zh-CN": "媒体" },
  },
];

// What a group of site keys means where it appears, by key prefix
// ("namespace.path."). The keys alone leave these open.
const CONTEXT_NOTES: Record<string, string> = {
  "labels.anim.":
    "Animation names. One name labels both the In and the Out animation, so name the motion in a direction-neutral word: Fade is neither fading in nor fading out, and Pop is a quick springy scale.",
  "labels.overlayAnim.":
    "Title animation names. One name labels both the In and the Out animation, so name the motion in a direction-neutral word: Fade is neither fading in nor fading out, and Pop is a quick springy scale.",
  "inspector.motion.":
    "Camera move controls. Roll is the camera turning around its forward axis; it is never a phone's photo library.",
  "editor.topBar.aspects.":
    "Aspect ratio names listed together in one menu, so each must read differently: Vertical is 9:16 and Portrait is 3:4.",
};

// How each language addresses the person using the app.
const VOICE: Record<Target, string> = {
  es: "Latin American neutral Spanish, informal tú",
  "pt-BR": "Brazilian Portuguese, você",
  fr: "French, vous",
  de: "German, informal du, as consumer creative apps use",
  ja: "Japanese, polite です/ます form; UI labels as short noun phrases",
  ko: "Korean, polite 해요체; UI labels as short noun phrases",
  "zh-CN": "Simplified Chinese as used in mainland China; no 您 unless the English is formal",
};

type Tree = { [key: string]: string | Tree };
type Lock = Record<string, Record<string, string>>;

const sha = (text: string) => createHash("sha1").update(text).digest("hex").slice(0, 12);

function flatten(tree: Tree, prefix = "", out = new Map<string, string>()): Map<string, string> {
  for (const [key, value] of Object.entries(tree)) {
    const keyPath = prefix ? `${prefix}.${key}` : key;
    if (typeof value === "string") {
      out.set(keyPath, value);
      continue;
    }
    flatten(value, keyPath, out);
  }
  return out;
}

// Rebuilds the nested tree in the English key order, so translated files
// diff line for line against their source.
function unflatten(order: Iterable<string>, values: Map<string, string>): Tree {
  const root: Tree = {};
  for (const key of order) {
    const parts = key.split(".");
    let node = root;
    for (const part of parts.slice(0, -1)) {
      node[part] ??= {};
      node = node[part] as Tree;
    }
    node[parts.at(-1)!] = values.get(key)!;
  }
  return root;
}

function argumentsOf(message: string): string {
  const found = new Set<string>();
  const walk = (elements: MessageFormatElement[]) => {
    for (const element of elements) {
      if (element.type === TYPE.argument) found.add(`${element.value}:argument`);
      if (element.type === TYPE.number) found.add(`${element.value}:number`);
      if (element.type === TYPE.date) found.add(`${element.value}:date`);
      if (element.type === TYPE.time) found.add(`${element.value}:time`);
      if (element.type === TYPE.tag) {
        found.add(`${element.value}:tag`);
        walk(element.children);
      }
      if (element.type === TYPE.plural || element.type === TYPE.select) {
        found.add(`${element.value}:${element.type === TYPE.plural ? "plural" : "select"}`);
        for (const option of Object.values(element.options)) walk(option.value);
      }
    }
  };
  walk(parse(message));
  return [...found].sort().join(",");
}

function readJson<T>(file: string, fallback: T): T {
  return existsSync(file) ? (JSON.parse(readFileSync(file, "utf8")) as T) : fallback;
}

function writeJson(file: string, value: unknown) {
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`);
}

function client(): GoogleGenAI {
  const config = geminiClientConfig(process.env);
  if (!config.configured) {
    throw new Error("GOOGLE_APPLICATION_CREDENTIALS_JSON is missing; the translation script needs Vertex credentials.");
  }
  return new GoogleGenAI(config.options);
}

// The syntax a catalog's strings are written in: the site's ICU messages, or
// the printf-style format strings Apple's catalogs carry.
type Syntax = "icu" | "printf";

type Job = {
  locale: Target;
  namespace: string;
  entries: [string, string][];
  syntax: Syntax;
  product: string;
  // What a key means where it appears, when the key alone leaves it open.
  notes: Map<string, string>;
};

const WEB_PRODUCT = "Donkey Cut, a video editor that runs in the browser";

// What each syntax tells the model about the strings it is handed.
const SYNTAX_RULES: Record<Syntax, string[]> = {
  icu: [
    "- Keep ICU MessageFormat syntax exactly: {name} arguments, {count, plural, ...} and {x, select, ...} blocks with their selector keywords (one, other, =0) untranslated, # inside plurals, and <tag>…</tag> markup. Translate only the human text inside them. Add the plural categories the target language needs (ja, ko and zh-CN need only other).",
  ],
  printf: [
    "- Keep printf format specifiers exactly: every %@, %lld, %d, %lf in the English appears in the translation with the same type. To reorder arguments, number them all (%2$@ … %1$lld). A literal percent sign is written %%.",
    "- A key ending in |one or |other is one plural form of the same string: |one is said of a count of one, |other of every other count.",
    "- Keep Markdown markup (**bold**, [text](url)) with its URLs unchanged, and keep line breaks where the English has them.",
  ],
};

// The notes for the keys in a batch, one line per key that has one.
function contextLines(job: Job): string[] {
  const lines = job.entries.flatMap(([key]) => {
    const note = job.notes.get(key);
    return note ? [`  - ${key}: ${note}`] : [];
  });
  return lines.length > 0 ? ["- Where these keys appear:", ...lines] : [];
}

// The site's notes for a namespace's keys, from the prefixes they fall under.
function siteNotes(namespace: string, keys: Iterable<string>): Map<string, string> {
  const notes = new Map<string, string>();
  for (const key of keys) {
    const prefix = Object.keys(CONTEXT_NOTES).find((start) => `${namespace}.${key}`.startsWith(start));
    if (prefix) {
      notes.set(key, CONTEXT_NOTES[prefix]);
    }
  }
  return notes;
}

async function translateBatch(ai: GoogleGenAI, job: Job): Promise<Map<string, string>> {
  const prompt = [
    `Translate these user interface strings of ${job.product}, from English into ${LOCALE_NAMES[job.locale]} (${job.locale}).`,
    `Voice: ${VOICE[job.locale]}.`,
    `Namespace "${job.namespace}" — the keys tell you where each string appears.`,
    "Rules:",
    ...SYNTAX_RULES[job.syntax],
    "- Keep it as short as the English; these are buttons, menu items and labels.",
    "- Keep punctuation conventions of the target language (ellipsis …, quotes).",
    ...GLOSSARY.map((term) => `- ${term}`),
    "- Use these words for these terms wherever the English means the sense given, inflected as the grammar needs:",
    ...TERMS.map((term) => `  - ${term.english} (${term.sense}): ${term.words[job.locale]}`),
    ...contextLines(job),
    "Return every key with its translation.",
    "",
    JSON.stringify(Object.fromEntries(job.entries), null, 2),
  ].join("\n");

  const response = await ai.models.generateContent({
    model: geminiModels.flash,
    contents: prompt,
    config: {
      responseMimeType: "application/json",
      responseSchema: {
        type: Type.ARRAY,
        items: {
          type: Type.OBJECT,
          properties: { key: { type: Type.STRING }, text: { type: Type.STRING } },
          required: ["key", "text"],
        },
      },
    },
  });
  const rows = JSON.parse(response.text ?? "[]") as { key: string; text: string }[];
  return new Map(rows.map((row) => [row.key, row.text]));
}

// The printf specifiers of a format string, by argument position: "1:@,2:lld".
// Unnumbered specifiers take positions in order; %% is a literal percent.
function specifiersOf(text: string): string {
  const found = new Map<number, string>();
  const pattern = /%(?:(\d+)\$)?[-+ #0]*\d*(?:\.\d+)?(hh|h|ll|l|q|L|z|t|j)?([@dDuUxXoOfFeEgGaAcCsSp%])/g;
  let next = 1;
  for (const match of text.matchAll(pattern)) {
    if (match[3] === "%") {
      continue;
    }
    const position = match[1] ? Number(match[1]) : next++;
    found.set(position, `${match[2] ?? ""}${match[3]}`);
  }
  return [...found].sort(([a], [b]) => a - b).map(([position, type]) => `${position}:${type}`).join(",");
}

// What a translation must carry over from its English, per syntax.
const SIGNATURE: Record<Syntax, (text: string) => string> = { icu: argumentsOf, printf: specifiersOf };

// Translates a job, keeping only results whose arguments match the English.
async function translateChecked(ai: GoogleGenAI, job: Job): Promise<Map<string, string>> {
  const done = new Map<string, string>();
  let pending = job.entries;
  for (let attempt = 0; attempt < 2 && pending.length > 0; attempt++) {
    const result = await translateBatch(ai, { ...job, entries: pending });
    for (const [key, english] of pending) {
      const text = result.get(key);
      if (!text) continue;
      try {
        if (SIGNATURE[job.syntax](text) === SIGNATURE[job.syntax](english)) done.set(key, text);
      } catch {
        // Unparseable ICU: retried below.
      }
    }
    pending = pending.filter(([key]) => !done.has(key));
  }
  if (pending.length > 0) {
    throw new Error(
      `${job.locale}/${job.namespace}: no valid translation for ${pending.map(([key]) => key).join(", ")}`,
    );
  }
  return done;
}

async function pool<T>(items: T[], size: number, run: (item: T) => Promise<void>) {
  let next = 0;
  const workers = Array.from({ length: Math.min(size, items.length) }, async () => {
    while (next < items.length) await run(items[next++]);
  });
  await Promise.all(workers);
}

async function syncCatalogs(dir: string, check: boolean) {
  const namespaces = readdirSync(path.join(dir, "en"))
    .filter((name) => name.endsWith(".json"))
    .map((name) => name.slice(0, -".json".length));
  const lockPath = path.join(dir, LOCK_FILE);
  const lock = readJson<Lock>(lockPath, {});
  const targets = LOCALES.filter((locale): locale is Job["locale"] => locale !== "en");

  // What each locale is missing or holds stale.
  const jobs: Job[] = [];
  const results = new Map<string, Map<string, string>>();
  const englishOf = new Map<string, Map<string, string>>();
  for (const namespace of namespaces) {
    const english = flatten(readJson<Tree>(path.join(dir, "en", `${namespace}.json`), {}));
    englishOf.set(namespace, english);
    for (const locale of targets) {
      const current = flatten(readJson<Tree>(path.join(dir, locale, `${namespace}.json`), {}));
      const locked = lock[`${locale}/${namespace}`] ?? {};
      const stale = [...english].filter(([key, text]) => !current.has(key) || locked[key] !== sha(text));
      for (let i = 0; i < stale.length; i += BATCH_SIZE) {
        jobs.push({
          locale,
          namespace,
          entries: stale.slice(i, i + BATCH_SIZE),
          syntax: "icu",
          product: WEB_PRODUCT,
          notes: siteNotes(namespace, english.keys()),
        });
      }
      results.set(`${locale}/${namespace}`, current);
    }
  }

  if (check) {
    if (jobs.length > 0) {
      const names = [...new Set(jobs.map((job) => `${job.locale}/${job.namespace}`))];
      throw new Error(`Stale translations in ${dir}: ${names.join(", ")}. Run bun scripts/i18n-translate.ts.`);
    }
    return;
  }

  // Writes one catalog back in English order, dropping keys English lost, and
  // records the English each translation now stands for. A catalog is written
  // the moment its last batch lands, so a run that dies partway (a provider
  // outage) keeps what it finished and the next run picks up the rest.
  const save = (locale: Job["locale"], namespace: string) => {
    const english = englishOf.get(namespace)!;
    const current = results.get(`${locale}/${namespace}`)!;
    writeJson(path.join(dir, locale, `${namespace}.json`), unflatten(english.keys(), current));
    lock[`${locale}/${namespace}`] = Object.fromEntries([...english].map(([key, text]) => [key, sha(text)]));
    writeJson(lockPath, Object.fromEntries(Object.entries(lock).sort(([a], [b]) => a.localeCompare(b))));
  };

  // Catalogs with nothing to translate only shed the keys English lost.
  const pending = new Map<string, number>();
  for (const job of jobs) {
    const key = `${job.locale}/${job.namespace}`;
    pending.set(key, (pending.get(key) ?? 0) + 1);
  }
  for (const namespace of namespaces) {
    for (const locale of targets) {
      if (!pending.has(`${locale}/${namespace}`)) {
        save(locale, namespace);
      }
    }
  }

  const ai = jobs.length > 0 ? client() : null;
  let finished = 0;
  await pool(jobs, CONCURRENCY, async (job) => {
    const translated = await translateChecked(ai!, job);
    const key = `${job.locale}/${job.namespace}`;
    const current = results.get(key)!;
    for (const [entry, text] of translated) current.set(entry, text);
    finished++;
    console.log(`[${finished}/${jobs.length}] ${key}: ${translated.size} strings`);

    const left = pending.get(key)! - 1;
    pending.set(key, left);
    if (left === 0) {
      save(job.locale, job.namespace);
    }
  });
}

// ---- Native apps --------------------------------------------------------

const REPO_ROOT = path.join(import.meta.dirname, "..", "..");
const APPS_DIR = path.join(REPO_ROOT, "apps");
const NATIVE_LOCK = path.join(APPS_DIR, ".i18n-source-lock.json");

// Build output and dependency folders hold compiled copies of the catalogs.
const SKIPPED_DIRS = new Set([".build", "DerivedData", "build", "node_modules"]);

// Apple names Simplified Chinese by script.
const APPLE_LOCALE: Record<Job["locale"], string> = {
  es: "es",
  "pt-BR": "pt-BR",
  fr: "fr",
  de: "de",
  ja: "ja",
  ko: "ko",
  "zh-CN": "zh-Hans",
};

// The plural categories written for a count, per language. Apple falls back
// to "other" for a category a translation leaves out, so the rarer ones
// (French and Spanish "many", for millions) read as "other".
const PLURAL_FORMS = ["one", "other"] as const;
const SINGLE_FORM_LOCALES = new Set<Job["locale"]>(["ja", "ko", "zh-CN"]);

// What each app is, so the model knows where its strings appear. Keyed by the
// folder under apps/.
const NATIVE_PRODUCTS: Record<string, string> = {
  Donkey: "Donkey, the Mac menu bar app that lends the Donkey Cut video editor the Mac's hardware for encoding and screen recording",
  ios: "Donkey Cut for iPhone and Apple Watch, which records clips with a teleprompter and keeps notes and ideas for the Donkey Cut video editor",
};

type Rows = Map<string, string>;

// One native catalog: its rows per locale ("key", or "key|one" for a plural
// form), what is already translated, and how to write translations back.
type NativeCatalog = {
  name: string;
  product: string;
  // The developer comment on a row's string, where one says how it is used.
  notes: (locale: Job["locale"]) => Map<string, string>;
  english: (locale: Job["locale"]) => Rows;
  current: (locale: Job["locale"]) => Rows;
  save: (translated: Map<Job["locale"], Rows>) => void;
};

type StringUnit = { state?: string; value: string };
type XcLocalization = {
  stringUnit?: StringUnit;
  variations?: { plural?: Record<string, { stringUnit: StringUnit }> };
};
type XcEntry = { comment?: string; shouldTranslate?: boolean; localizations?: Record<string, XcLocalization> };
type XcCatalog = { sourceLanguage: string; strings: Record<string, XcEntry>; version: string };

function findFiles(dir: string, match: (file: string) => boolean, out: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (!SKIPPED_DIRS.has(entry.name)) {
        findFiles(full, match, out);
      }
      continue;
    }
    if (match(full)) {
      out.push(full);
    }
  }
  return out;
}

function productFor(file: string): string {
  const app = path.relative(APPS_DIR, file).split(path.sep)[0];
  const product = NATIVE_PRODUCTS[app];
  if (!product) {
    throw new Error(`${file}: no product description for apps/${app}; add it to NATIVE_PRODUCTS.`);
  }
  return product;
}

// Xcode writes catalogs with a space before each colon; matching it keeps a
// catalog from churning when Xcode next saves it.
function writeXcodeJson(file: string, value: unknown) {
  const text = JSON.stringify(value, null, 2).replace(/^(\s*"(?:[^"\\]|\\.)*"): /gm, "$1 : ");
  writeFileSync(file, `${text}\n`);
}

// An English entry as rows: one for a plain string, one per needed plural
// form for a counted one. Keys Xcode extracted carry no English localization;
// their key is their English.
function englishRows(key: string, entry: XcEntry, locale: Job["locale"], out: Rows) {
  const english = entry.localizations?.en;
  const plural = english?.variations?.plural;
  if (plural) {
    for (const form of formsFor(locale)) {
      const text = plural[form]?.stringUnit.value ?? plural.other?.stringUnit.value;
      if (text === undefined) {
        throw new Error(`"${key}": an English plural needs an "other" form.`);
      }
      out.set(`${key}|${form}`, text);
    }
    return;
  }
  if (english?.variations) {
    throw new Error(`"${key}": only plural variations are supported.`);
  }
  out.set(key, english?.stringUnit?.value ?? key);
}

function formsFor(locale: Job["locale"]): readonly string[] {
  return SINGLE_FORM_LOCALES.has(locale) ? ["other"] : PLURAL_FORMS;
}

function xcstringsCatalog(file: string): NativeCatalog {
  const catalog = JSON.parse(readFileSync(file, "utf8")) as XcCatalog;
  const translatable = Object.entries(catalog.strings).filter(([, entry]) => entry.shouldTranslate !== false);

  const english = (locale: Job["locale"]) => {
    const rows: Rows = new Map();
    for (const [key, entry] of translatable) {
      englishRows(key, entry, locale, rows);
    }
    return rows;
  };

  // Only finished translations count; Xcode marks one it wants redone as
  // needs_review.
  const current = (locale: Job["locale"]) => {
    const rows: Rows = new Map();
    for (const [key, entry] of translatable) {
      const localization = entry.localizations?.[APPLE_LOCALE[locale]];
      if (localization?.stringUnit?.state === "translated") {
        rows.set(key, localization.stringUnit.value);
      }
      for (const [form, variant] of Object.entries(localization?.variations?.plural ?? {})) {
        if (variant.stringUnit.state === "translated") {
          rows.set(`${key}|${form}`, variant.stringUnit.value);
        }
      }
    }
    return rows;
  };

  const save = (translated: Map<Job["locale"], Rows>) => {
    for (const [key, entry] of translatable) {
      const plural = entry.localizations?.en?.variations?.plural !== undefined;
      for (const [locale, rows] of translated) {
        const unit = (row: string): { stringUnit: StringUnit } => ({
          stringUnit: { state: "translated", value: rows.get(row)! },
        });
        const localization: XcLocalization = plural
          ? { variations: { plural: Object.fromEntries(formsFor(locale).map((form) => [form, unit(`${key}|${form}`)])) } }
          : unit(key);
        entry.localizations = { ...entry.localizations, [APPLE_LOCALE[locale]]: localization };
      }
      entry.localizations = Object.fromEntries(
        Object.entries(entry.localizations ?? {}).sort(([a], [b]) => a.localeCompare(b)),
      );
    }
    writeXcodeJson(file, catalog);
  };

  // Every row of a commented string carries its comment, plural forms too.
  const notes = (locale: Job["locale"]) => {
    const rows = english(locale);
    const byKey = new Map(translatable.map(([key, entry]) => [key, entry.comment]));
    const out = new Map<string, string>();
    for (const row of rows.keys()) {
      const comment = byKey.get(row) ?? byKey.get(row.split("|")[0]);
      if (comment) {
        out.set(row, comment);
      }
    }
    return out;
  };

  return { name: path.relative(REPO_ROOT, file), product: productFor(file), notes, english, current, save };
}

const STRINGS_LINE = /^\s*"((?:[^"\\]|\\.)*)"\s*=\s*"((?:[^"\\]|\\.)*)"\s*;/gm;

function unescapeStrings(text: string): string {
  return text.replace(/\\(["\\n])/g, (_, char: string) => (char === "n" ? "\n" : char));
}

function escapeStrings(text: string): string {
  return text.replace(/["\\]/g, "\\$&").replace(/\n/g, "\\n");
}

function readStrings(file: string): Rows {
  if (!existsSync(file)) {
    return new Map();
  }
  const rows: Rows = new Map();
  for (const match of readFileSync(file, "utf8").matchAll(STRINGS_LINE)) {
    rows.set(unescapeStrings(match[1]), unescapeStrings(match[2]));
  }
  return rows;
}

// A plain .strings table under en.lproj (the iOS Settings bundle), whose
// translations live in sibling <locale>.lproj folders.
function stringsCatalog(file: string): NativeCatalog {
  const english = readStrings(file);
  const localized = (locale: Job["locale"]) =>
    path.join(path.dirname(path.dirname(file)), `${APPLE_LOCALE[locale]}.lproj`, path.basename(file));

  const save = (translated: Map<Job["locale"], Rows>) => {
    for (const [locale, rows] of translated) {
      const lines = [...english.keys()].map((key) => `"${escapeStrings(key)}" = "${escapeStrings(rows.get(key)!)}";`);
      mkdirSync(path.dirname(localized(locale)), { recursive: true });
      writeFileSync(localized(locale), `${lines.join("\n")}\n`);
    }
  };

  return {
    name: path.relative(REPO_ROOT, file),
    product: productFor(file),
    notes: () => new Map(),
    english: () => english,
    current: (locale) => readStrings(localized(locale)),
    save,
  };
}

function nativeCatalogs(): NativeCatalog[] {
  const xcstrings = findFiles(APPS_DIR, (file) => file.endsWith(".xcstrings"));
  const strings = findFiles(
    APPS_DIR,
    (file) => file.endsWith(".strings") && path.basename(path.dirname(file)) === "en.lproj",
  );
  return [...xcstrings.map(xcstringsCatalog), ...strings.map(stringsCatalog)];
}

async function syncNative(check: boolean) {
  const catalogs = nativeCatalogs();
  const lock = readJson<Record<string, Lock>>(NATIVE_LOCK, {});
  const targets = LOCALES.filter((locale): locale is Job["locale"] => locale !== "en");

  // What each locale of each catalog is missing or holds stale.
  const jobs: { catalog: NativeCatalog; job: Job }[] = [];
  const results = new Map<NativeCatalog, Map<Job["locale"], Rows>>();
  for (const catalog of catalogs) {
    const perLocale = new Map<Job["locale"], Rows>();
    for (const locale of targets) {
      const english = catalog.english(locale);
      const current = catalog.current(locale);
      const locked = lock[catalog.name]?.[APPLE_LOCALE[locale]] ?? {};
      const stale = [...english].filter(([row, text]) => !current.has(row) || locked[row] !== sha(text));
      for (let i = 0; i < stale.length; i += BATCH_SIZE) {
        jobs.push({
          catalog,
          job: {
            locale,
            namespace: catalog.name,
            entries: stale.slice(i, i + BATCH_SIZE),
            syntax: "printf",
            product: catalog.product,
            notes: catalog.notes(locale),
          },
        });
      }
      perLocale.set(locale, current);
    }
    results.set(catalog, perLocale);
  }

  if (check) {
    if (jobs.length > 0) {
      const names = [...new Set(jobs.map(({ catalog, job }) => `${catalog.name} (${job.locale})`))];
      throw new Error(`Stale native translations: ${names.join(", ")}. Run bun scripts/i18n-translate.ts --native-only.`);
    }
    return;
  }

  const ai = jobs.length > 0 ? client() : null;
  let finished = 0;
  await pool(jobs, CONCURRENCY, async ({ catalog, job }) => {
    const translated = await translateChecked(ai!, job);
    const current = results.get(catalog)!.get(job.locale)!;
    for (const [row, text] of translated) {
      current.set(row, text);
    }
    finished++;
    console.log(`[${finished}/${jobs.length}] ${job.locale} ${catalog.name}: ${translated.size} strings`);
  });

  // Write every catalog back, keeping only rows English still has, and record
  // the English each translation now stands for.
  const nextLock: Record<string, Lock> = {};
  for (const catalog of catalogs) {
    const perLocale = results.get(catalog)!;
    for (const locale of targets) {
      const english = catalog.english(locale);
      const kept: Rows = new Map([...english.keys()].map((row) => [row, perLocale.get(locale)!.get(row)!]));
      perLocale.set(locale, kept);
      nextLock[catalog.name] ??= {};
      nextLock[catalog.name][APPLE_LOCALE[locale]] = Object.fromEntries(
        [...english].map(([row, text]) => [row, sha(text)]),
      );
    }
    catalog.save(perLocale);
  }
  writeJson(NATIVE_LOCK, Object.fromEntries(Object.entries(nextLock).sort(([a], [b]) => a.localeCompare(b))));
}

const args = process.argv.slice(2);
const check = args.includes("--check");
const nativeOnly = args.includes("--native-only");
const extra = args.flatMap((arg, i) => (arg === "--dir" ? [args[i + 1]] : []));
if (!nativeOnly) {
  for (const dir of [SITE_MESSAGES, ...extra]) {
    await syncCatalogs(path.resolve(dir), check);
  }
}
await syncNative(check);
