"use client";

import { useEffect } from "react";
import { onEngineUserConfirmed } from "@/cut/lib/api";
import { flushNoteOutbox } from "@/cut/lib/noteOutbox";

/** Send pending note edits when a send may now land or must go now: the
 * browser back online, the session confirming its account, and the page
 * hiding or closing (as keepalive requests). Mounted once for the whole app. */
export function useNoteOutboxSync(): void {
  useEffect(() => {
    const flush = () => void flushNoteOutbox();
    const unload = () => void flushNoteOutbox("unloading");
    const hidden = () => {
      if (document.visibilityState === "hidden") {
        unload();
      }
    };

    window.addEventListener("online", flush);
    window.addEventListener("pagehide", unload);
    document.addEventListener("visibilitychange", hidden);
    const offConfirmed = onEngineUserConfirmed(flush);
    return () => {
      window.removeEventListener("online", flush);
      window.removeEventListener("pagehide", unload);
      document.removeEventListener("visibilitychange", hidden);
      offConfirmed();
    };
  }, []);
}
