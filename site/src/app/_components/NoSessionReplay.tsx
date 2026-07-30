"use client";

import posthog from "posthog-js";
import { useEffect } from "react";

// Mounted by surfaces that composite video onto a canvas every frame — the Cut
// app and the shared player. Session replay's canvas capture reads that canvas
// back off the GPU several times a second and records every timeline mutation
// and media request, which degrades playback more the longer the tab lives, so
// these surfaces never record. This stops a recorder that entered through a
// client-side navigation; instrumentation-client.ts keeps direct loads from
// starting one at all.
export function NoSessionReplay() {
  useEffect(() => {
    if (process.env.NEXT_PUBLIC_POSTHOG_KEY) posthog.stopSessionRecording();
  }, []);
  return null;
}
