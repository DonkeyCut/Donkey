"use client";

import { useEffect, useRef, useState } from "react";
import { toolDisplayOf } from "@/cut/lib/toolDisplay";

// Google's Search Suggestions beside a grounded result, shown as Google sends
// them: HTML and CSS with links to the searches. The markup renders in a
// sandboxed frame that runs no script, sized to its content, and every link
// opens a new tab.

const FRAME_HEAD =
  '<meta charset="utf-8">' +
  "<meta http-equiv=\"Content-Security-Policy\" content=\"default-src 'none'; style-src 'unsafe-inline'; img-src https: data:; font-src https: data:\">" +
  '<base target="_blank">' +
  "<style>html,body{margin:0;padding:0;background:transparent;overflow:hidden}</style>";

export function SearchSuggestions({ output }: { output: unknown }) {
  const blocks = toolDisplayOf(output)?.searchSuggestions;
  if (!blocks) return null;
  return (
    <div className="flex w-full basis-full flex-col gap-1">
      {blocks.map((html) => (
        <SuggestionFrame key={html} html={html} />
      ))}
    </div>
  );
}

function SuggestionFrame({ html }: { html: string }) {
  const ref = useRef<HTMLIFrameElement>(null);
  const [height, setHeight] = useState(0);

  useEffect(() => {
    const frame = ref.current;
    if (!frame) return;
    let observer: ResizeObserver | null = null;
    const measure = () => {
      const doc = frame.contentDocument;
      if (doc?.body) setHeight(Math.ceil(doc.body.scrollHeight));
    };
    const attach = () => {
      observer?.disconnect();
      const body = frame.contentDocument?.body;
      if (!body) return;
      measure();
      observer = new ResizeObserver(measure);
      observer.observe(body);
    };
    frame.addEventListener("load", attach);
    attach();
    return () => {
      frame.removeEventListener("load", attach);
      observer?.disconnect();
    };
  }, [html]);

  return (
    <iframe
      ref={ref}
      title="Google Search suggestions"
      srcDoc={`<!doctype html><html><head>${FRAME_HEAD}</head><body>${html}</body></html>`}
      sandbox="allow-same-origin allow-popups allow-popups-to-escape-sandbox"
      referrerPolicy="no-referrer"
      className="block w-full border-0 bg-transparent"
      style={{ height }}
    />
  );
}
