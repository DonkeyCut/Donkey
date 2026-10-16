"use client";

import { useEffect } from "react";

// Mounted by the Cut app. Its layout marks the app subtree translate="no", but
// dialogs, menus, popovers, tooltips and toasts portal into <body>, outside
// that subtree, where a browser's translator still rewrites the text nodes
// React owns; the next commit that moves one throws NotFoundError out of
// insertBefore or removeChild. Marking <html> covers every portal while the
// app is mounted, and the marketing pages stay translatable once it unmounts.
export function NoTranslate() {
  useEffect(() => {
    const html = document.documentElement;
    html.setAttribute("translate", "no");
    return () => html.removeAttribute("translate");
  }, []);
  return null;
}
