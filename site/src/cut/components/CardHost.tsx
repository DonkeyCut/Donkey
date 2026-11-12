"use client";

import { useEffect } from "react";
import { usePathname, useRouter } from "next/navigation";
import { framedHref, reportHostPage, useHostBridge } from "@/cut/lib/hostBridge";
import { projectHref, useCutBase } from "@/cut/lib/nav";
import { useEditor } from "@/cut/lib/store";

// The editor's address names its project: /app/p/<id>.
const PROJECT_PATH = /\/p\/([^/?#]+)/;

/**
 * The frame's line to the ChatGPT card on every page of the app: the host's
 * theme and bands and the project to show come in, and the page the frame
 * shows goes out. Outside the card both are inert.
 */
export function CardHost() {
  const router = useRouter();
  const base = useCutBase();
  const projectId = usePathname().match(PROJECT_PATH)?.[1] ?? null;

  // The assistant made or edited another project: open it here, as a new
  // card would on the web, so its edits run on screen.
  useHostBridge((shown) => {
    if (shown !== projectId) {
      router.push(framedHref(projectHref(base, shown, "home")));
    }
  });
  const name = useEditor((s) => (projectId && s.projectId === projectId ? s.projectName || null : null));

  // Each page change, and the name once the editor has loaded it.
  useEffect(() => {
    reportHostPage(projectId, name);
  }, [projectId, name]);

  return null;
}
