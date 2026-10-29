"use client";

import { useEffect } from "react";
import { usePathname } from "next/navigation";
import { reportHostPage, useHostBridge } from "@/cut/lib/hostBridge";
import { useEditor } from "@/cut/lib/store";

// The editor's address names its project: /app/p/<id>.
const PROJECT_PATH = /\/p\/([^/?#]+)/;

/**
 * The frame's line to the ChatGPT card on every page of the app: the host's
 * theme and bands come in, and the page the frame shows goes out. Outside the
 * card both are inert.
 */
export function CardHost() {
  useHostBridge();
  const projectId = usePathname().match(PROJECT_PATH)?.[1] ?? null;
  const name = useEditor((s) => (projectId && s.projectId === projectId ? s.projectName || null : null));

  // Each page change, and the name once the editor has loaded it.
  useEffect(() => {
    reportHostPage(projectId, name);
  }, [projectId, name]);

  return null;
}
