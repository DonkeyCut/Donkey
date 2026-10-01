"use client";

import { useEffect } from "react";

/** The work mark TabStatus puts in front of the title: a running count or a check. */
const MARK = /^(?:[✓●]|\(\d+\+?\)) /;

/** The title without the work mark. */
export const stripTabMark = (title: string) => title.replace(MARK, "");

/**
 * The tab names what is open: the project, the folder, the note, the page.
 *
 * Each view passes its own name, and null while it defers to a view inside it
 * that names something more specific. The title is set on every show, so a
 * page the router kept mounted takes the tab back when it is visited again.
 * A work mark already on the tab stays in front of the new name.
 */
export function useTabTitle(title: string | null | undefined) {
  useEffect(() => {
    if (!title) return;
    const mark = document.title.match(MARK)?.[0] ?? "";
    document.title = mark + title;
  }, [title]);
}
