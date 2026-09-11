import { mdxToText } from "@/lib/blog/faq";

export type BlogHeading = { id: string; text: string; level: 2 | 3 };

// The anchor a heading gets from its text. The rendered heading and the
// outline beside it both derive it here, so a link from one lands on the other.
export const headingId = (text: string) =>
  text
    .toLowerCase()
    .trim()
    .replace(/&/g, "and")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");

// The outline of an article from its source: the second- and third-level
// headings outside code fences, in order.
export function extractHeadings(source: string): BlogHeading[] {
  const headings: BlogHeading[] = [];
  let inFence = false;
  for (const raw of source.split("\n")) {
    const line = raw.trim();
    if (/^(```|~~~)/.test(line)) {
      inFence = !inFence;
      continue;
    }
    if (inFence) continue;
    const match = line.match(/^(##|###)\s+(.+?)\s*#*$/);
    if (!match) continue;
    const text = mdxToText(match[2] ?? "");
    const id = headingId(text);
    if (text && id) headings.push({ id, text, level: match[1] === "##" ? 2 : 3 });
  }
  return headings;
}
