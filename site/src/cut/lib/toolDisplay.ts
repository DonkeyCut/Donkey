// What a tool hands the person and keeps from the model. A tool output's
// `display` key carries markup the chat shows beside the result (Google's
// Search Suggestions for a grounded check); the chat loop moves it off the
// response the model reads, and the ChatGPT adapter moves it into the
// widget-only metadata.

export interface ToolDisplay {
  /** Search Suggestions blocks, HTML and CSS from the search provider, shown
   * as given wherever a grounded result shows. */
  searchSuggestions?: string[];
}

/** The output without its `display` key, and the display read from it. */
export function splitToolDisplay(output: unknown): { output: unknown; display?: ToolDisplay } {
  if (!output || typeof output !== "object" || Array.isArray(output) || !("display" in output)) return { output };
  const { display, ...rest } = output as { display?: unknown };
  const shaped = toolDisplayOf({ display });
  return shaped ? { output: rest, display: shaped } : { output: rest };
}

export interface SearchLink {
  query: string;
  url: string;
}

const ANCHOR = /<a\b[^>]*?\bhref\s*=\s*"([^"]*)"[^>]*>([\s\S]*?)<\/a>/gi;
const ENTITIES: Record<string, string> = { amp: "&", quot: '"', apos: "'", lt: "<", gt: ">", nbsp: " " };

function decodeEntities(text: string): string {
  return text.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (whole, code: string) => {
    if (code[0] !== "#") return ENTITIES[code.toLowerCase()] ?? whole;
    const n = code[1] === "x" || code[1] === "X" ? parseInt(code.slice(2), 16) : parseInt(code.slice(1), 10);
    return Number.isFinite(n) && n > 0 && n <= 0x10ffff ? String.fromCodePoint(n) : whole;
  });
}

/** The searches a Search Suggestions block links to, as text and URL, for a
 * client that shows links and renders no markup. */
export function searchLinksOf(html: string): SearchLink[] {
  const links: SearchLink[] = [];
  for (const [, href, inner] of html.matchAll(ANCHOR)) {
    const url = URL.parse(decodeEntities(href));
    const query = decodeEntities(inner.replace(/<[^>]*>/g, "")).replace(/\s+/g, " ").trim();
    if (!url || url.protocol !== "https:" || !query) continue;
    if (!links.some((l) => l.url === url.href)) links.push({ query, url: url.href });
  }
  return links;
}

/** The display a UI tool output carries, held to its shape. */
export function toolDisplayOf(output: unknown): ToolDisplay | undefined {
  const raw =
    output && typeof output === "object" && !Array.isArray(output) ? (output as { display?: unknown }).display : undefined;
  if (!raw || typeof raw !== "object") return undefined;
  const list = (raw as { searchSuggestions?: unknown }).searchSuggestions;
  const searchSuggestions = Array.isArray(list)
    ? [...new Set(list.filter((h): h is string => typeof h === "string" && h.trim() !== ""))]
    : [];
  return searchSuggestions.length > 0 ? { searchSuggestions } : undefined;
}
