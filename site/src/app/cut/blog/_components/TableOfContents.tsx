"use client";

import { useEffect, useRef, useState } from "react";

import type { BlogHeading } from "@/lib/blog/headings";
import { cn } from "@/lib/utils";

const SCROLL_OFFSET = 100;

// The sticky outline beside an article, from the headings the server read out
// of the source, with the section in view marked as the reader scrolls.
export function TableOfContents({ headings }: { headings: BlogHeading[] }) {
  const [activeId, setActiveId] = useState("");
  const navRef = useRef<HTMLElement>(null);

  useEffect(() => {
    const elements = headings
      .map((heading) => document.getElementById(heading.id))
      .filter((element): element is HTMLElement => element !== null);
    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (entry.isIntersecting) setActiveId(entry.target.id);
        }
      },
      { rootMargin: "-120px 0px -60%", threshold: 0 },
    );
    for (const element of elements) observer.observe(element);
    return () => observer.disconnect();
  }, [headings]);

  useEffect(() => {
    if (!activeId || !navRef.current) return;
    navRef.current
      .querySelector(`a[href="#${CSS.escape(activeId)}"]`)
      ?.scrollIntoView({ block: "nearest", behavior: "smooth" });
  }, [activeId]);

  if (headings.length === 0) return null;

  return (
    <nav
      ref={navRef}
      aria-label="On this page"
      className="sticky top-24 max-h-[calc(100vh-8rem)] w-full overflow-y-auto [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
    >
      <h3 className="mb-4 text-sm font-semibold text-ink">Overview</h3>
      <ul className="space-y-2">
        {headings.map((heading) => (
          <li key={heading.id} className={cn(heading.level === 3 && "pl-3", heading.id === "faqs" && "mt-3 border-t border-ink/15 pt-3")}>
            <a
              href={`#${heading.id}`}
              className={cn(
                "block text-sm no-underline",
                activeId === heading.id ? "font-medium text-ink" : "text-[#666] hover:text-ink",
              )}
              onClick={(event) => {
                event.preventDefault();
                const element = document.getElementById(heading.id);
                if (!element) return;
                setActiveId(heading.id);
                window.history.pushState(null, "", `#${heading.id}`);
                const top = element.getBoundingClientRect().top + window.scrollY - SCROLL_OFFSET;
                window.scrollTo({ top, behavior: "instant" });
              }}
            >
              {heading.text}
            </a>
          </li>
        ))}
      </ul>
    </nav>
  );
}

// Lands a deep link at its heading with the same offset the outline uses.
export function ScrollToHash() {
  useEffect(() => {
    const id = window.location.hash.slice(1);
    if (!id) return;
    const element = document.getElementById(id);
    if (!element) return;
    const top = element.getBoundingClientRect().top + window.scrollY - SCROLL_OFFSET;
    window.scrollTo({ top, behavior: "instant" });
  }, []);
  return null;
}
