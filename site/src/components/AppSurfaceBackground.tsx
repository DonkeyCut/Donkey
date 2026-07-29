"use client";

import { useEffect } from "react";

// The signed-in /app surface renders on white, but the root html/body default to
// the cream landing background — which shows through in the browser overscroll
// area above the content. While the app is mounted we flag the html element so a
// scoped rule in globals.css paints it (and the overscroll) white instead.
export function AppSurfaceBackground() {
  useEffect(() => {
    const root = document.documentElement;
    root.classList.add("app-surface");
    return () => root.classList.remove("app-surface");
  }, []);

  return null;
}
