"use client";

import { usePathname } from "next/navigation";
import { useEffect } from "react";

import { BEACON_PATH, UNTRACKED_PAGES } from "@/lib/meta/identity";

// Reports each page the browser shows to Meta through this site's own server.
// Production builds only, like the rest of analytics.
export function MetaPageView() {
  const pathname = usePathname();

  useEffect(() => {
    if (process.env.NODE_ENV !== "production" || UNTRACKED_PAGES.test(window.location.pathname)) {
      return;
    }
    // The address without its query or fragment, which can carry tokens.
    const { origin, pathname: path } = window.location;
    navigator.sendBeacon(BEACON_PATH, JSON.stringify({ url: `${origin}${path}` }));
  }, [pathname]);

  return null;
}
