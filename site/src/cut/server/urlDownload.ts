import { spawn } from "node:child_process";
import { accessSync, constants as fsConstants, realpathSync } from "node:fs";
import { mkdir, readdir, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { Defuddle } from "defuddle/node";
import { parseHTML } from "linkedom";
import { convertToMp4, fitsAlready, streamCodecs } from "./convert";
import type { LibrarySource } from "./library";

// Bring back whatever a URL points at. yt-dlp, resolved from PATH, pulls
// anything with a video or audio stream (TikTok, YouTube, Instagram, …); X's
// auth-free syndication endpoint covers the posts it can't touch — photos, an
// Article, a post that is only words; and any other page falls back to its
// readable text. Shared by the local engine's import routes (urlImport.ts) and
// the cloud render worker's import_url jobs.

const MEDIA_EXT = /\.(mp4|mov|m4v|webm|mkv|mp3|m4a|aac|wav|ogg|flac)$/i;

interface YtMeta {
  title?: string;
  thumbnail?: string;
  description?: string;
  uploader?: string;
  upload_date?: string;
  webpage_url?: string;
  extractor?: string;
}

/** What a finished download hands its consumer: the media files (inside a
 * temp dir the wrapper deletes afterwards — one for yt-dlp's merged output,
 * one per photo for a photo post) plus what the extractor knew about them.
 * Each file may carry a `poster`: the source's own cover image, saved beside
 * it. `text` is the source's own words — a post's body, an Article, a video's
 * title and description — shown in the chat beside the media it came with. A
 * source that is only words lands with no files and that text alone. */
export interface Downloaded {
  files: { file: string; title: string; poster?: string }[];
  source: LibrarySource;
  text?: string;
}

// A video's own words for the chat: its title and description joined, capped so
// a long YouTube description (link dumps, chapter lists) can't flood the chat.
// TikTok/Instagram often repeat the caption as both fields, so drop a
// description that just restates the title.
const MAX_SOURCE_TEXT = 2000;
// An Article or a page is imported *for* its text, so it gets a wider cap.
const MAX_PAGE_TEXT = 8000;

function sourceTextFromMeta(meta: YtMeta): string | undefined {
  const title = (meta.title || "").trim();
  const desc = (meta.description || "").trim();
  const body =
    desc && desc !== title && !desc.startsWith(title)
      ? title
        ? `${title}\n\n${desc}`
        : desc
      : title || desc;
  return clamp(body, MAX_SOURCE_TEXT) || undefined;
}

const X_STATUS_RE = /^https?:\/\/(?:www\.|mobile\.)?(?:x|twitter)\.com\/[^/]+\/status\/(\d+)/i;
const X_ARTICLE_RE = /^https?:\/\/(?:www\.)?(?:x|twitter)\.com\/i\/article\/\d+/i;
const X_URL_RE = /^https?:\/\/(?:www\.|mobile\.)?(?:x|twitter)\.com\//i;

/** Work down a ladder of extractors until one comes back with something: each
 * rung handles what the rung before it can't, and a rung that recognizes
 * nothing at the URL returns null so the next one gets its turn. An X post
 * offers its Article or photos first, then yt-dlp for the video stream the
 * syndication endpoint won't serve, then the stills that stream left behind,
 * then the post's words alone. Every other URL tries yt-dlp, then the page
 * itself — what it says and what it shows. When no rung produces anything, the
 * first failure is what surfaces — it names the real cause. */
export async function download(url: string, tmp: string): Promise<Downloaded> {
  if (IMAGE_URL_RE.test(url)) return downloadDirectImage(url, tmp);
  const rungs: (() => Promise<Downloaded | null>)[] = [];
  const postId = X_STATUS_RE.exec(url)?.[1];
  // An X post's lower rungs are the post itself — its stills, its words — so a
  // video stream that won't come down still imports as the post. Everywhere
  // else the page under a video host is its thumbnail, and filing that as the
  // import is worse than saying why the video didn't arrive.
  const xLadder = !!postId || X_ARTICLE_RE.test(url);
  if (postId) {
    // One syndication fetch feeds every X rung.
    const post = fetchPost(postId);
    rungs.push(
      () => xPostMedia(post, url, tmp, { deferVideo: true }),
      () => downloadMedia(url, tmp),
      () => xPostMedia(post, url, tmp, { deferVideo: false }),
      () => xPostText(post, url)
    );
  } else if (X_ARTICLE_RE.test(url)) {
    rungs.push(() => xArticle({}, url, tmp));
  } else {
    rungs.push(() => downloadMedia(url, tmp), () => readPage(url, tmp));
  }
  const failures: unknown[] = [];
  for (const rung of rungs) {
    try {
      const got = await rung();
      if (got) return got;
    } catch (e) {
      if (e instanceof MediaHostError && !xLadder) throw e;
      failures.push(e);
    }
  }
  const first = failures[0];
  throw first instanceof Error ? first : new Error("Nothing could be imported from that URL.");
}

/** yt-dlp knows this site as a video host and still could not bring the video
 * back. The import fails on it rather than falling through to the page. */
class MediaHostError extends Error {}

/** The bundled tool is missing — every retry lands here, so the first attempt
 * is the last. */
class MissingToolError extends Error {}

async function downloadMedia(url: string, tmp: string): Promise<Downloaded> {
  // Read what sits at the URL before pulling any bytes. The extractor name
  // says whether this is a site that serves video, and that decides what a
  // failed download means: on a video host the import stops with the real
  // reason, on an ordinary page the page rung takes over. A URL yt-dlp can't
  // read at all throws here, so a page import spawns it once.
  let probe: YtMeta;
  let bin: string;
  try {
    ({ meta: probe, bin } = await probeUrl(url));
  } catch (e) {
    // The failure names the extractor that produced it. A media host that
    // could not be read is the end of the import — falling through to the page
    // rung here would land a video site's cover image and its markup in place
    // of the video, and bury the reason the download failed.
    if (e instanceof YtDlpError && e.extractor && !PAGE_EXTRACTORS.has(e.extractor))
      throw new MediaHostError(e.message);
    throw e;
  }
  const videoHost = !PAGE_EXTRACTORS.has((probe.extractor ?? "").toLowerCase());
  let meta: YtMeta;
  let out: string;
  try {
    ({ meta, dir: out } = await runYtDlp(url, tmp, bin));
  } catch (e) {
    if (!videoHost) throw e;
    throw new MediaHostError(e instanceof Error ? e.message : "Download failed.");
  }
  // Pick the largest media file left behind (the merged output).
  const names = (await readdir(out)).filter((f) => MEDIA_EXT.test(f));
  if (names.length === 0) throw new Error("Nothing downloadable was found at that URL.");
  const sized = await Promise.all(
    names.map(async (n) => ({ n, size: (await stat(path.join(out, n))).size }))
  );
  const file = await playableMedia(path.join(out, sized.sort((a, b) => b.size - a.size)[0].n));
  // The site's own cover for this video, so a card and the viewer have a first
  // frame to show before a byte of the video is decoded.
  const poster = await savePoster(meta.thumbnail, out, path.parse(file).name);
  const clip = {
    file,
    title: (meta.title || "Imported clip").slice(0, 120),
    ...(poster ? { poster } : {}),
  };
  const source = {
    url: meta.webpage_url || url,
    title: meta.title,
    uploader: meta.uploader,
    uploadDate: meta.upload_date,
  };
  // A page-scraping extractor means an ordinary web page that happened to
  // embed this clip. The page is the import — its words and its pictures — and
  // the clip is one of the things it showed.
  if (PAGE_EXTRACTORS.has((meta.extractor ?? "").toLowerCase())) {
    const page = await readPage(url, tmp).catch(() => null);
    if (page) return { files: [clip, ...page.files], source, text: page.text };
  }
  return { files: [clip], source, text: sourceTextFromMeta(meta) };
}

// The extractors yt-dlp reports when it scraped an ordinary web page rather
// than a media host it knows.
const PAGE_EXTRACTORS = new Set(["generic", "html5"]);

const IMAGE_URL_RE = /\.(png|jpe?g|webp|gif|avif|bmp)(?:$|\?)/i;

/** What comes back has to play where the import is going — the phone's viewer,
 * the Mac's player, a browser — and a site's best stream is often VP9 or AV1,
 * which Apple decodes nowhere. A file whose picture is already H.264 is handed
 * back untouched; anything else is re-encoded into one that plays. A
 * conversion that fails leaves the original: a file that plays in fewer places
 * beats no import at all. */
async function playableMedia(file: string): Promise<string> {
  const codecs = await streamCodecs(file);
  // Sound alone decodes everywhere the import goes.
  if (!codecs.video) return file;
  if (fitsAlready(file, codecs, { shrink: false, sdr: false })) return file;
  const out = path.join(path.dirname(file), `${path.parse(file).name}.h264.mp4`);
  try {
    await convertToMp4({ log: [], outPath: out, progress: 0, tmpDir: path.dirname(file) }, file, out);
    return out;
  } catch {
    return file;
  }
}

/** Save the source's cover image beside the media it belongs to. A cover that
 * won't download is no reason to fail an import, so this answers nothing and
 * the media lands without one. */
async function savePoster(
  url: string | undefined,
  dir: string,
  base: string
): Promise<string | undefined> {
  if (!url) return undefined;
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(20_000) });
    if (!res.ok) return undefined;
    const ext = IMAGE_TYPES[(res.headers.get("content-type") ?? "").split(";")[0].toLowerCase()];
    if (!ext) return undefined;
    const bytes = Buffer.from(await res.arrayBuffer());
    if (bytes.byteLength === 0 || bytes.byteLength > MAX_IMAGE_BYTES) return undefined;
    const file = path.join(dir, `${base}.poster.${ext}`);
    await writeFile(file, bytes);
    return file;
  } catch {
    return undefined;
  }
}

async function downloadDirectImage(url: string, dir: string): Promise<Downloaded> {
  const res = await fetch(url);
  if (!res.ok) throw new Error("Could not download that image.");
  const name = path.basename(new URL(url).pathname) || "image.jpg";
  const file = path.join(dir, name);
  await writeFile(file, Buffer.from(await res.arrayBuffer()));
  return { files: [{ file, title: name.slice(0, 120) }], source: { url } };
}

interface UrlEntity {
  url?: string;
  expanded_url?: string;
}

interface SyndicatedPost {
  text?: string;
  id_str?: string;
  user?: { name?: string; screen_name?: string };
  photos?: { url?: string }[];
  entities?: { urls?: UrlEntity[]; media?: UrlEntity[] };
  mediaDetails?: { type?: string }[];
  video?: unknown;
  article?: XArticle;
}

interface XArticle {
  title?: string;
  preview_text?: string;
  cover_media?: { media_info?: { original_img_url?: string } };
}

/** Read a post through X's embed endpoint. It is auth-free but requires the
 * token its embed script derives from the id — same float math here, precision
 * loss included. Resolves to null when X won't answer, so the ladder moves on
 * instead of failing the import. */
async function fetchPost(id: string): Promise<SyndicatedPost | null> {
  const token = ((Number(id) / 1e15) * Math.PI).toString(36).replace(/(0+|\.)/g, "");
  try {
    const res = await fetch(
      `https://cdn.syndication.twimg.com/tweet-result?id=${id}&token=${token}`
    );
    if (!res.ok) return null;
    return (await res.json()) as SyndicatedPost;
  } catch {
    return null;
  }
}

/** The media an X post carries: its Article (cover image and body) or its
 * photos. The endpoint serves a video post's still but not its stream, so with
 * `deferVideo` such a post passes to yt-dlp; the same rung runs again after
 * yt-dlp, where the still is the best that's left. */
async function xPostMedia(
  pending: Promise<SyndicatedPost | null>,
  url: string,
  dir: string,
  { deferVideo }: { deferVideo: boolean }
): Promise<Downloaded | null> {
  const post = await pending;
  if (!post) return null;
  const uploader = uploaderOf(post);
  if (post.article) return xArticle(post.article, url, dir, postText(post));
  const hasVideo = !!post.video || (post.mediaDetails ?? []).some((m) => m.type !== "photo");
  if (deferVideo && hasVideo) return null;
  const photoUrls = (post.photos ?? []).map((p) => p.url).filter((u): u is string => !!u);
  if (photoUrls.length === 0) return null;
  const text = postText(post);
  const baseTitle = text || `Photo from ${uploader ?? "X"}`;
  const files: Downloaded["files"] = [];
  for (const [i, photoUrl] of photoUrls.entries()) {
    files.push(
      await savePhoto(
        photoUrl,
        dir,
        `${post.id_str ?? "post"}-${i + 1}`,
        photoUrls.length > 1 ? `${baseTitle} (${i + 1}/${photoUrls.length})` : baseTitle
      )
    );
  }
  return {
    files,
    source: { url, title: text || undefined, uploader },
    text: text || undefined,
  };
}

/** The last rung for an X post: its words, with no media at all. This is what
 * a text-only post imports as. */
async function xPostText(
  pending: Promise<SyndicatedPost | null>,
  url: string
): Promise<Downloaded | null> {
  const post = await pending;
  if (!post) return null;
  const text = postText(post);
  if (!text) return null;
  return {
    files: [],
    source: { url, title: text.slice(0, 120), uploader: uploaderOf(post) },
    text,
  };
}

/** An X Article: the post carries the title and a cover image, and the article
 * body rides in the post page's hydration payload. The syndicated preview is
 * truncated to a couple of lines, so the full body is read from the page first
 * and the preview stands in when that payload moves. */
async function xArticle(
  article: XArticle,
  url: string,
  dir: string,
  postWords?: string
): Promise<Downloaded> {
  const scraped = await readArticlePayload(url).catch(() => ({}) as ArticlePayload);
  const title = scraped.title || article.title;
  const body = scraped.text || article.preview_text;
  const cover = scraped.cover || article.cover_media?.media_info?.original_img_url;
  const text = clamp([postWords, title, body].filter(Boolean).join("\n\n"), MAX_PAGE_TEXT);
  if (!text && !cover) {
    throw new Error("Could not read that X Article — import the post that published it.");
  }
  const files = cover
    ? [await savePhoto(cover, dir, "article-cover", title || "Article cover")]
    : [];
  return { files, source: { url, title: title || undefined }, text: text || undefined };
}

interface ArticlePayload {
  title?: string;
  text?: string;
  cover?: string;
}

/** X renders an Article in the browser, but its page ships the article in the
 * hydration payload as plain JS string literals — title, full body, cover
 * image. Read those three out of the payload; a shape change yields nothing
 * and the caller falls back to the syndicated preview. */
async function readArticlePayload(pageUrl: string): Promise<ArticlePayload> {
  const { html } = await fetchPage(pageUrl);
  const at = html.search(/"?__typename"?\s*:\s*"ArticleEntity"/);
  if (at < 0) return {};
  const payload = html.slice(at);
  return {
    title: jsString(payload, "title"),
    text: jsString(payload, "plain_text"),
    cover: jsString(payload, "original_img_url"),
  };
}

/** The value of `key:"…"` in a JS payload, unescaped. */
function jsString(payload: string, key: string): string | undefined {
  const m = new RegExp(`"?${key}"?\\s*:\\s*"((?:[^"\\\\]|\\\\.)*)"`).exec(payload);
  if (!m) return undefined;
  try {
    return JSON.parse(`"${m[1].replace(/\\'/g, "'")}"`) as string;
  } catch {
    return undefined;
  }
}

/** A post's own words. The endpoint HTML-escapes them and ends them with a
 * t.co link per attachment, so entities decide what each link becomes: an
 * outside link expands to where it points, and X's own self-links — the
 * photos, the Article, a quoted post — drop, since the import already carries
 * what they point at. */
function postText(post: SyndicatedPost): string {
  let text = decodeEntities(post.text || "");
  for (const u of [...(post.entities?.urls ?? []), ...(post.entities?.media ?? [])]) {
    if (!u.url) continue;
    const target = u.expanded_url ?? "";
    text = text.split(u.url).join(target && !X_URL_RE.test(target) ? target : "");
  }
  return text.replace(/\s+/g, " ").trim();
}

function uploaderOf(post: SyndicatedPost): string | undefined {
  const handle = post.user?.screen_name;
  return handle ? `@${handle}` : post.user?.name;
}

/** Fetch one pbs.twimg.com image at its original resolution (behind
 * name=orig) and write it into the temp dir. */
async function savePhoto(
  photoUrl: string,
  dir: string,
  stem: string,
  title: string
): Promise<{ file: string; title: string }> {
  let img = await fetch(`${photoUrl}${photoUrl.includes("?") ? "&" : "?"}name=orig`);
  if (!img.ok) img = await fetch(photoUrl);
  if (!img.ok) throw new Error("Could not download the post's photos.");
  const ext = (
    /\.(png|jpe?g|webp|gif)(?:$|\?)/i.exec(photoUrl)?.[1] ||
    (img.headers.get("content-type")?.includes("png") ? "png" : "jpg")
  ).toLowerCase();
  const file = path.join(dir, `${stem}.${ext}`);
  await writeFile(file, Buffer.from(await img.arrayBuffer()));
  return { file, title: title.slice(0, 120) };
}

// A browser user agent, since a page served to a crawler is often an error or
// a stub, and a ceiling on how much of a page is read into memory.
const PAGE_UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36";
const MAX_PAGE_BYTES = 4_000_000;

/** The page's markup plus the address it settled on after redirects, which is
 * what its relative links and images resolve against. */
async function fetchPage(url: string): Promise<{ html: string; url: string }> {
  const res = await fetch(url, {
    headers: { "user-agent": PAGE_UA, accept: "text/html,application/xhtml+xml,*/*" },
    redirect: "follow",
  });
  if (!res.ok) throw new Error(`That page could not be read (${res.status}).`);
  const type = res.headers.get("content-type") ?? "";
  if (type && !/text\/|xml|json/i.test(type)) throw new Error("That URL is not a readable page.");
  const buf = await res.arrayBuffer();
  const bytes = buf.byteLength > MAX_PAGE_BYTES ? buf.slice(0, MAX_PAGE_BYTES) : buf;
  return { html: Buffer.from(bytes).toString("utf8"), url: res.url || url };
}

// Below this a page's readable text is chrome — a cookie notice, a nav bar —
// and worth nothing to the chat, so the ladder keeps the earlier failure.
const MIN_PAGE_TEXT = 40;

/** The last rung for anything that isn't a post: read the page itself. A
 * landing page, an article or a docs page imports as what it says and what it
 * shows — its readable text plus the pictures on it — so a link the user
 * pasted for its content arrives as content. Returns null for a page that has
 * neither, leaving the earlier failure to surface. */
async function readPage(url: string, dir: string): Promise<Downloaded | null> {
  const page = await fetchPage(url);
  const { document } = parseHTML(page.html);
  // Defuddle (a Readability successor) picks the article out of the page and
  // hands it back as markdown, so headings, lists and links survive and nav,
  // sidebars and cookie banners don't.
  const article = await Defuddle(document, page.url, { markdown: true }).catch(() => null);
  const title = (article?.title || document.title || "").trim();
  const body = [title, (article?.content ?? "").trim()].filter(Boolean).join("\n\n");
  const text = clamp(body, MAX_PAGE_TEXT);
  const files = await pageImages(article, document, page.url, title, dir);
  if (files.length === 0 && text.length < MIN_PAGE_TEXT) return null;
  return {
    files,
    source: { url, title: title || undefined, uploader: article?.site?.trim() || undefined },
    text: text.length >= MIN_PAGE_TEXT ? text : undefined,
  };
}

// How many of a page's pictures come along, and the size band a file has to
// land in to count as one: under the floor are icons, spacers, avatars and
// tracking pixels, over the ceiling is something no import should drag into a
// project. More candidates than that are fetched, since some won't qualify.
const MAX_PAGE_IMAGES = 6;
const MIN_IMAGE_BYTES = 10_000;
const MAX_IMAGE_BYTES = 15_000_000;
const IMAGE_CANDIDATES = 16;

/** Download the pictures a page shows, in the order it presents them, and
 * write them into the temp dir beside anything else the import found. */
async function pageImages(
  article: { image?: string; content?: string } | null,
  document: Document,
  pageUrl: string,
  pageTitle: string,
  dir: string
): Promise<Downloaded["files"]> {
  const refs = imageCandidates(article, document, pageUrl).slice(0, IMAGE_CANDIDATES);
  const saved = await Promise.all(
    refs.map((ref, i) => savePageImage(ref, pageUrl, i, dir).catch(() => null))
  );
  const kept = saved.filter((f): f is SavedImage => !!f).slice(0, MAX_PAGE_IMAGES);
  // A picture the page captioned keeps that caption; the rest are named after
  // the page and counted, the way a multi-photo post's are.
  return kept.map((img, i) => ({
    file: img.file,
    title: (
      img.alt ||
      (kept.length > 1 ? `${pageTitle} (${i + 1}/${kept.length})` : pageTitle) ||
      "Image"
    ).slice(0, 120),
  }));
}

interface SavedImage {
  file: string;
  alt?: string;
}

interface ImageRef {
  url: string;
  alt?: string;
}

// Vector icons and favicons are chrome, never content.
const SKIP_IMAGE_RE = /\.(svg|ico)(?:$|[?#])/i;

/** The pictures worth importing, best first: the one the page nominates for a
 * link preview, then the ones the extractor kept with the article — its
 * content rather than its logos and nav icons — then the rest of the
 * document's images, each at the sharpest size its srcset offers. */
function imageCandidates(
  article: { image?: string; content?: string } | null,
  document: Document,
  pageUrl: string
): ImageRef[] {
  const seen = new Set<string>();
  const refs: ImageRef[] = [];
  const add = (raw: string | null | undefined, alt?: string | null) => {
    const abs = absolute(raw ?? undefined, pageUrl);
    if (!abs || seen.has(abs) || SKIP_IMAGE_RE.test(abs)) return;
    seen.add(abs);
    refs.push({ url: abs, alt: alt?.trim() || undefined });
  };
  add(article?.image);
  // The extractor writes the article as markdown, so its pictures are the
  // image links in it, in the order the page shows them.
  for (const m of (article?.content ?? "").matchAll(/!\[([^\]]*)\]\(\s*([^)\s]+)/g)) add(m[2], m[1]);
  for (const img of document.querySelectorAll("img")) {
    add(widestSrc(img.getAttribute("srcset")) ?? img.getAttribute("src"), img.getAttribute("alt"));
  }
  return refs;
}

/** The sharpest candidate in a srcset — a responsive page lists one picture at
 * several widths. */
function widestSrc(srcset?: string | null): string | undefined {
  let best: { url: string; weight: number } | undefined;
  for (const candidate of (srcset ?? "").split(",")) {
    const [src, descriptor] = candidate.trim().split(/\s+/);
    if (!src) continue;
    const size = parseFloat(descriptor ?? "");
    const weight = !Number.isFinite(size)
      ? 1
      : descriptor?.endsWith("x")
        ? size * 1000
        : size;
    if (!best || weight > best.weight) best = { url: src, weight };
  }
  return best?.url;
}

const IMAGE_TYPES: Record<string, string> = {
  "image/jpeg": "jpg",
  "image/jpg": "jpg",
  "image/png": "png",
  "image/webp": "webp",
  "image/gif": "gif",
  "image/avif": "avif",
};

/** Fetch one of a page's images. The response's own type names the file, since
 * a URL that ends in nothing recognizable still serves a real picture, and
 * anything under the floor or not an image at all is skipped. */
async function savePageImage(
  ref: ImageRef,
  pageUrl: string,
  index: number,
  dir: string
): Promise<SavedImage | null> {
  const res = await fetch(ref.url, {
    headers: { "user-agent": PAGE_UA, accept: "image/*,*/*", referer: pageUrl },
  });
  if (!res.ok) return null;
  const ext = IMAGE_TYPES[(res.headers.get("content-type") ?? "").split(";")[0].toLowerCase()];
  if (!ext) return null;
  if (Number(res.headers.get("content-length")) > MAX_IMAGE_BYTES) return null;
  const bytes = Buffer.from(await res.arrayBuffer());
  if (bytes.byteLength < MIN_IMAGE_BYTES || bytes.byteLength > MAX_IMAGE_BYTES) return null;
  const file = path.join(dir, `page-${index + 1}.${ext}`);
  await writeFile(file, bytes);
  return { file, alt: ref.alt };
}

/** An absolute http(s) address for a page's link, or nothing for the inline
 * and non-web schemes an import can't fetch. */
function absolute(raw: string | undefined, base: string): string | undefined {
  if (!raw) return undefined;
  try {
    const u = new URL(raw, base);
    return u.protocol === "http:" || u.protocol === "https:" ? u.toString() : undefined;
  } catch {
    return undefined;
  }
}

const ENTITIES: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: " ",
};

function decodeEntities(s: string): string {
  return s.replace(/&(#x?[0-9a-f]+|[a-z]+);/gi, (whole, body: string) => {
    if (!body.startsWith("#")) return ENTITIES[body.toLowerCase()] ?? whole;
    const hex = body[1] === "x" || body[1] === "X";
    const code = parseInt(hex ? body.slice(2) : body.slice(1), hex ? 16 : 10);
    return Number.isFinite(code) && code > 0 && code <= 0x10ffff
      ? String.fromCodePoint(code)
      : whole;
  });
}

function clamp(text: string, max: number): string {
  const t = text.trim();
  return t.length > max ? `${t.slice(0, max).trimEnd()}…` : t;
}

// YouTube hands each of its player clients a different set of formats, and the
// one yt-dlp reaches for first can serve URLs that 403 the moment the download
// starts — the site breaks them one at a time. Each entry is a full attempt
// with a different client, so a broken one costs a retry instead of the
// import. Only YouTube reads the argument, so only YouTube pays for the ladder.
const YT_PLAYER_CLIENTS = [null, "mweb", "android"];
const YT_HOST = /(^|\.)(youtube\.com|youtu\.be)$/i;

function playerClients(url: string): (string | null)[] {
  try {
    return YT_HOST.test(new URL(url).hostname) ? YT_PLAYER_CLIENTS : [null];
  } catch {
    return [null];
  }
}

/** Every yt-dlp this machine can run, in PATH order and deduped by the file
 * they point at — the copy we ship comes first, since the engine puts its
 * tools ahead of the rest of PATH.
 *
 * They are not interchangeable. The build we bundle carries curl_cffi, so it
 * impersonates a browser on every request; a copy installed with pip or
 * Homebrew usually can't, and takes yt-dlp's plain path instead. Sites tell
 * the two apart: TikTok currently answers the impersonated request with a page
 * the extractor can't read, while the plain path solves its challenge and gets
 * the video. So a run that fails on one build is worth retrying on the next. */
function ytDlpBinaries(): string[] {
  const seen = new Set<string>();
  const bins: string[] = [];
  for (const dir of (process.env.PATH ?? "").split(path.delimiter)) {
    if (!dir) continue;
    const file = path.join(dir, "yt-dlp");
    try {
      accessSync(file, fsConstants.X_OK);
      const real = realpathSync(file);
      if (seen.has(real)) continue;
      seen.add(real);
      bins.push(file);
    } catch {
      // Not on this entry of PATH.
    }
  }
  return bins;
}

/** Read what sits at a URL, through whichever yt-dlp can read it. Hands back
 * the build that answered so the download starts with the one that works. */
async function probeUrl(url: string): Promise<{ meta: YtMeta; bin: string }> {
  const bins = ytDlpBinaries();
  if (bins.length === 0) throw new MissingToolError("yt-dlp is not available in this build.");
  let first: unknown;
  for (const bin of bins) {
    try {
      return { meta: await ytDlpJson(bin, ["--skip-download", "--dump-json", url]), bin };
    } catch (e) {
      first ??= e;
    }
  }
  throw first instanceof Error ? first : new Error("Nothing could be read at that URL.");
}

// What the whole ladder may spend. Someone is watching a tile the entire time,
// and the cloud rung gives up on a job at ten minutes, so every retry together
// has to finish inside that.
const DOWNLOAD_BUDGET_MS = 8 * 60_000;

/** Pull the media at `url` into a fresh directory under `dir`, working through
 * the builds and player clients until one comes back with the file. Each
 * attempt writes into its own directory: a failed one can leave a finished
 * video-only format behind, and the largest file in the directory is the one
 * that lands — a leftover would beat a smaller merged file that has sound. */
async function runYtDlp(
  url: string,
  dir: string,
  preferred: string
): Promise<{ meta: YtMeta; dir: string }> {
  const bins = [preferred, ...ytDlpBinaries().filter((b) => b !== preferred)];
  const deadline = Date.now() + DOWNLOAD_BUDGET_MS;
  const attempts = bins.flatMap((bin) => playerClients(url).map((client) => ({ bin, client })));
  let first: unknown;
  for (const [i, { bin, client }] of attempts.entries()) {
    const left = deadline - Date.now();
    if (left <= 0) break;
    const out = path.join(dir, `try${i}`);
    await mkdir(out, { recursive: true });
    try {
      return { meta: await ytDlp(bin, url, out, client, left), dir: out };
    } catch (e) {
      if (e instanceof MissingToolError) throw e;
      first ??= e;
    }
  }
  throw first instanceof Error ? first : new Error("Download failed.");
}

function ytDlp(
  bin: string,
  url: string,
  dir: string,
  client: string | null,
  timeoutMs: number
): Promise<YtMeta> {
  return ytDlpJson(bin, [
    ...(client ? ["--extractor-args", `youtube:player_client=${client}`] : []),
    // Take the best video and the best audio and put them together. Asking for
    // a ready-made mp4 first would land whatever single file the site keeps
    // around for compatibility — on YouTube that is 360p next to a 4K original.
    //
    // Codec leads the sort. Apple decodes H.264 and HEVC and nothing else, so
    // a taller VP9 or AV1 stream is a file that plays nowhere the import is
    // going: the phone's viewer, the Mac's own player, Safari. Instagram
    // serves 1440p VP9 beside 1080p H.264, and the 1080p file is the one worth
    // having. A source with no H.264 at all still comes down, and the
    // conversion below makes it playable.
    "-f", "bestvideo*+bestaudio/best",
    "-S", "vcodec:h264,acodec:aac,res,fps,hdr:sdr",
    "--merge-output-format", "mp4",
    "-o", path.join(dir, "%(id)s.%(ext)s"),
    "--print-json",
    url,
  ], timeoutMs);
}

// yt-dlp reports failures as a stderr line aimed at people who file issues on
// its tracker. The library tile shows whatever comes back, so the shapes worth
// naming get a sentence someone can act on and the rest is trimmed down to the
// part that says what happened.
const YT_DLP_REASONS: [RegExp, string][] = [
  [/IP address is blocked|blocked from accessing|rate.?limit|too many requests|HTTP Error 429/i,
    "That site is blocking downloads from this network right now. Try again later."],
  [/private video|login required|sign in|requires authentication|members-only|age.?restrict/i,
    "That post is private or needs a sign-in."],
  [/not available in your country|geo.?restrict|geo.?block/i,
    "That post isn't available in this region."],
  [/video unavailable|does not exist|has been removed|HTTP Error 404|account.*(private|banned)/i,
    "That post isn't available any more."],
  [/unsupported url|no video formats found|no media found/i,
    "That link has nothing this can download."],
  [/unable to extract|unexpected response|failed to parse|rehydration/i,
    "That site changed how it serves this post, so the download tool can't read it."],
];

/** A yt-dlp run that ended in an error, holding the extractor named in its
 * last line — `ERROR: [TikTok] 76720…: …` — so the caller can tell a media
 * host's refusal from an ordinary page yt-dlp found no video in. */
class YtDlpError extends Error {
  constructor(
    message: string,
    readonly extractor: string | null
  ) {
    super(message);
  }
}

function ytDlpExtractor(stderr: string): string | null {
  const line = stderr.split("\n").filter(Boolean).slice(-1)[0] ?? "";
  return line.match(/^ERROR:\s*\[([^\]]+)\]/i)?.[1].toLowerCase() ?? null;
}

function ytDlpReason(stderr: string): string {
  const line = stderr.split("\n").filter(Boolean).slice(-1)[0] ?? "";
  for (const [pattern, reason] of YT_DLP_REASONS) if (pattern.test(line)) return reason;
  const clean = line
    .replace(/^ERROR:\s*/i, "")
    .replace(/^\[[^\]]+\]\s*[^:]*:\s*/, "")
    .split(/;\s*please report/i)[0]
    .trim();
  return clean ? clean.slice(0, 200) : "Download failed.";
}

/** Run yt-dlp and read the info dict it prints. */
function ytDlpJson(bin: string, args: string[], timeoutMs = 300_000): Promise<YtMeta> {
  return new Promise((resolve, reject) => {
    const p = spawn(bin, ["--no-playlist", "--no-progress", ...args]);
    const timer = setTimeout(() => {
      p.kill("SIGKILL");
      reject(new Error("Download timed out."));
    }, timeoutMs);
    timer.unref();
    let out = "";
    let err = "";
    p.stdout.on("data", (d) => (out += d.toString()));
    p.stderr.on("data", (d) => (err = (err + d.toString()).slice(-2000)));
    p.on("error", (e) => {
      clearTimeout(timer);
      // Bun and Node word a missing binary differently; the code is the same.
      reject(
        (e as NodeJS.ErrnoException).code === "ENOENT"
          ? new MissingToolError("yt-dlp is not available in this build.")
          : e
      );
    });
    p.on("close", (code) => {
      clearTimeout(timer);
      if (code !== 0) {
        reject(new YtDlpError(ytDlpReason(err), ytDlpExtractor(err)));
        return;
      }
      // The info dict comes back as JSON; take the last JSON line.
      const line = out.trim().split("\n").reverse().find((l) => l.trimStart().startsWith("{"));
      try {
        resolve(line ? (JSON.parse(line) as YtMeta) : {});
      } catch {
        resolve({});
      }
    });
  });
}
