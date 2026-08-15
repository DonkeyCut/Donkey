// Where the next new project lands.
//
// A project's residency is fixed the moment it is created, so creation is the
// one point where the user gets a say — and the say sticks: the choice is
// remembered on this browser until they change it. What they can choose from
// is not up to them. The cloud needs a signed-in account, this Mac needs the
// Donkey app running, and with only one of those reachable there is nothing to
// pick.
//
// The choice lives in a module-level store rather than component state because
// the control is on screen twice at once — the sidebar and the projects home —
// and picking in one has to move the other.
import { useSyncExternalStore } from "react";

import { authClient } from "@/lib/auth-client";
import { supportsBrowserStore } from "./backend/browser/opfs";
import { useCloudUsage, useLocalCompute } from "./backend/hooks";
import type { Residency } from "./residency";

const KEY = "cut-new-project-residency";

let choice: Residency | null = null;
const listeners = new Set<() => void>();

/** The user's own pick, or null when they have never picked. */
function current(): Residency | null {
  if (choice) return choice;
  try {
    const raw = localStorage.getItem(KEY);
    choice = raw === "cloud" || raw === "local" || raw === "browser" ? raw : null;
  } catch {
    choice = null;
  }
  return choice;
}

export function setNewProjectResidency(r: Residency) {
  if (current() === r) return;
  choice = r;
  try {
    localStorage.setItem(KEY, r);
  } catch {
    // Private mode: the choice holds for this session and not past a reload.
  }
  listeners.forEach((l) => l());
}

function subscribe(onChange: () => void) {
  listeners.add(onChange);
  return () => {
    listeners.delete(onChange);
  };
}

export type NewProjectTarget = {
  /** Where a project created right now would land. */
  target: Residency;
  /** What this browser and account can reach. A single entry means the button
   * has nothing to offer and the stored choice is ignored. */
  choices: Residency[];
  pick: (r: Residency) => void;
};

export function useNewProjectTarget(): NewProjectTarget {
  const { data: session } = authClient.useSession();
  // The engine is never probed here — this reads the answer the ConnectGate
  // already has, and redraws when it lands.
  const engineUp = useLocalCompute();
  const stored = useSyncExternalStore(subscribe, current, () => null);
  // "Local" is one place to the user, so one local entry ever lists: the Mac
  // engine when it is up, else the browser's own store.
  const store = supportsBrowserStore();
  const choices: Residency[] = !session
    ? ["local"]
    : engineUp
      ? ["cloud", "local"]
      : store
        ? ["cloud", "browser"]
        : ["cloud"];
  const picked = stored && choices.includes(stored) ? stored : null;
  // A new account starts on the cloud shelf, and stays there until its free
  // storage fills; from then on new projects land on the device. The read only
  // happens while the default is still deciding — a user who has picked is
  // done being defaulted.
  const usage = useCloudUsage(Boolean(session) && !picked, { poll: false });
  const u = usage.data;
  const cloudFull = u != null && u.quotaBytes !== null && u.bytes >= u.quotaBytes;
  const fallback = (cloudFull && choices.find((c) => c !== "cloud")) || choices[0];
  return {
    target: picked ?? fallback,
    choices,
    pick: setNewProjectResidency,
  };
}
