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
import { useLocalCompute } from "./backend/hooks";
import type { Residency } from "./residency";

const KEY = "cut-new-project-residency";

let choice: Residency | null = null;
const listeners = new Set<() => void>();

function current(): Residency {
  if (choice) return choice;
  try {
    const raw = localStorage.getItem(KEY);
    choice = raw === "cloud" || raw === "local" ? raw : "local";
  } catch {
    choice = "local";
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
  const stored = useSyncExternalStore(subscribe, current, () => "local" as const);
  const choices: Residency[] = !session ? ["local"] : engineUp ? ["local", "cloud"] : ["cloud"];
  return {
    target: choices.includes(stored) ? stored : choices[0],
    choices,
    pick: setNewProjectResidency,
  };
}
