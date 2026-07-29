"use client";

// The user reached for something that lives on this Mac while the Donkey app
// isn't answering. The ConnectGate turns this into its banner; the surfaces
// that know what was reached for are the ones that raise it — the library when
// a recalled item is clicked, and the editor by pinning a local project's
// residency, which the gate reads directly.
//
// It is raised by a gesture and dropped when the surface that raised it goes
// away, so the banner tracks what the user is looking at rather than standing
// over the whole app.
import { useSyncExternalStore } from "react";

let needed = false;
const listeners = new Set<() => void>();

export function setNeedsApp(next: boolean) {
  if (needed === next) return;
  needed = next;
  listeners.forEach((l) => l());
}

function subscribe(onChange: () => void) {
  listeners.add(onChange);
  return () => {
    listeners.delete(onChange);
  };
}

export function useNeedsApp(): boolean {
  return useSyncExternalStore(
    subscribe,
    () => needed,
    () => false
  );
}
