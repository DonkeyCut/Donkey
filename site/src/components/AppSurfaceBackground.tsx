"use client";

import { useEffect } from "react";

const SURFACE = "app-surface";

// The signed-in /app surface renders on white, but the root html/body default to
// the cream landing background — which shows through in the browser overscroll
// area above the content, and in every element keyed to bg-background until the
// app has hydrated. The flag goes on the html element inline, so the first
// painted frame is already the product surface, and comes back off when the app
// unmounts and the landing pages take the root back.
const paint = `document.documentElement.classList.add(${JSON.stringify(SURFACE)})`;

export function AppSurfaceBackground() {
  useEffect(() => {
    const root = document.documentElement;
    root.classList.add(SURFACE);
    return () => root.classList.remove(SURFACE);
  }, []);

  return <script dangerouslySetInnerHTML={{ __html: paint }} />;
}
