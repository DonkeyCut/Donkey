"use client";

import { useEffect } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { homeHref, useCutBase } from "@/cut/lib/nav";

/**
 * Carry an address from before Assets — the Library, or a Projects folder on
 * the app's root — to the same place in Assets, its query intact
 * (`?folder=…`, `?note=…`). A note link opens on the Notes tab.
 */
export function LegacyAssetsRedirect() {
  const router = useRouter();
  const base = useCutBase();
  const params = useSearchParams();

  useEffect(() => {
    const q = new URLSearchParams(params.toString());
    if (q.has("note") && !q.has("type")) {
      q.set("type", "notes");
    }
    const qs = q.toString();
    router.replace(qs ? `${homeHref(base, "assets")}?${qs}` : homeHref(base, "assets"));
  }, [router, base, params]);

  return null;
}
