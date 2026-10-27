"use client";

import { useEffect, useState } from "react";
import Markdown from "react-markdown";
import { useTranslations } from "next-intl";
import { cn } from "@/lib/utils";
import { baseMarkdownComponents } from "./markdownComponents";

// Rendering for text assets (a dropped script, notes, a CSV, an assistant
// deliverable): fetch the file behind the ref URL and render it by extension —
// markdown formatted, CSV as a table, everything else as plain text. Shared by
// the chat's document card and the lightbox's full view.

export type DocFormat = "markdown" | "csv" | "plain";

export function docFormat(name: string): DocFormat {
  const ext = name.toLowerCase().split(".").pop() ?? "";
  if (ext === "md" || ext === "markdown") return "markdown";
  if (ext === "csv" || ext === "tsv") return "csv";
  return "plain";
}

/** One fetch per URL per session — cards remount on every thread switch and
 * the lightbox opens the same file, so the text is cached. A failed fetch is
 * not cached, leaving the next mount to retry. */
const docCache = new Map<string, Promise<string>>();

function fetchDoc(url: string): Promise<string> {
  let p = docCache.get(url);
  if (!p) {
    p = fetch(url).then((r) => (r.ok ? r.text() : Promise.reject(new Error(String(r.status)))));
    p.catch(() => docCache.delete(url));
    docCache.set(url, p);
  }
  return p;
}

/** The file's text, fetched once per URL. `failed` marks an unreadable file so
 * callers can show a plain error instead of an empty card. */
export function useDocText(url: string): { text: string | null; failed: boolean } {
  // The loaded state remembers which URL it answers for, so a URL change
  // reads as loading again without a reset write in the effect.
  const [state, setState] = useState<{ url: string; text: string | null; failed: boolean } | null>(
    null
  );
  useEffect(() => {
    let alive = true;
    fetchDoc(url)
      .then((t) => alive && setState({ url, text: t, failed: false }))
      .catch(() => alive && setState({ url, text: null, failed: true }));
    return () => {
      alive = false;
    };
  }, [url]);
  return state?.url === url ? state : { text: null, failed: false };
}

/** Minimal quote-aware CSV/TSV rows. */
function parseRows(text: string, delim: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = "";
  let quoted = false;
  const push = () => {
    row.push(cell);
    cell = "";
  };
  const endRow = () => {
    push();
    // A lone trailing newline yields one empty cell; skip that row.
    if (row.length > 1 || row[0] !== "") rows.push(row);
    row = [];
  };
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quoted) {
      if (c === '"' && text[i + 1] === '"') {
        cell += '"';
        i++;
      } else if (c === '"') {
        quoted = false;
      } else {
        cell += c;
      }
    } else if (c === '"' && cell.trim() === "") {
      // Opens a quoted field even after leading whitespace (`a, "b, c"`),
      // which many exporters emit; the padding drops with the quote.
      quoted = true;
      cell = "";
    } else if (c === delim) {
      push();
    } else if (c === "\n") {
      endRow();
    } else if (c !== "\r") {
      cell += c;
    }
  }
  if (cell !== "" || row.length > 0) endRow();
  return rows;
}

const CSV_ROW_CAP = 200;

function CsvTable({ text, delim }: { text: string; delim: string }) {
  const t = useTranslations("home.docText");
  const rows = parseRows(text, delim);
  if (rows.length === 0) return <p className="text-muted-foreground">{t("empty")}</p>;
  const [head, ...body] = rows;
  const shown = body.slice(0, CSV_ROW_CAP);
  return (
    <div className="overflow-x-auto">
      <table className="w-full border-collapse text-left">
        <thead>
          <tr>
            {head.map((h, i) => (
              <th key={i} className="border-b border-border px-2 py-1 font-semibold whitespace-nowrap">
                {h}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {shown.map((r, i) => (
            <tr key={i} className="odd:bg-muted/40">
              {r.map((c, j) => (
                <td key={j} className="px-2 py-1 align-top">
                  {c}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
      {body.length > shown.length && (
        <p className="mt-1.5 text-muted-foreground">{t("moreRows", { count: body.length - shown.length })}</p>
      )}
    </div>
  );
}

/** A text file's content, formatted for its extension. Typography scales with
 * the caller's font-size classes on `className`. */
export function DocText({
  name,
  text,
  className,
}: {
  name: string;
  text: string;
  className?: string;
}) {
  const format = docFormat(name);
  if (format === "csv") {
    return (
      <div className={className}>
        <CsvTable text={text} delim={name.toLowerCase().endsWith(".tsv") ? "\t" : ","} />
      </div>
    );
  }
  if (format === "markdown") {
    return (
      <div className={cn("doc-md", className)}>
        <Markdown
          components={{
            ...baseMarkdownComponents,
            h1: (p) => <h1 className="mt-3 mb-1.5 text-[1.25em] font-semibold first:mt-0" {...p} />,
            h2: (p) => <h2 className="mt-3 mb-1.5 text-[1.1em] font-semibold first:mt-0" {...p} />,
            h3: (p) => <h3 className="mt-2 mb-1 font-semibold first:mt-0" {...p} />,
            code: (p) => <code className="rounded bg-muted px-1 py-px font-mono text-[0.9em]" {...p} />,
            pre: (p) => (
              <pre className="mb-1.5 overflow-x-auto rounded-md bg-muted/70 p-2 font-mono text-[0.9em] last:mb-0" {...p} />
            ),
            blockquote: (p) => (
              <blockquote className="mb-1.5 border-l-2 border-border pl-2 text-muted-foreground" {...p} />
            ),
          }}
        >
          {text}
        </Markdown>
      </div>
    );
  }
  return <pre className={cn("font-mono whitespace-pre-wrap", className)}>{text}</pre>;
}
