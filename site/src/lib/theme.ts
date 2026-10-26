// The page theme. "system" follows the OS; "light" and "dark" pin the root
// element's class, which globals.css reads ahead of the OS preference. The
// choice belongs to this browser and is applied by a head script before first
// paint, so a pinned theme never flashes the system one.

export const THEME_CHOICES = ["system", "light", "dark"] as const;
export type ThemeChoice = (typeof THEME_CHOICES)[number];

export const THEME_LABELS: Record<ThemeChoice, string> = {
  system: "System",
  light: "Light",
  dark: "Dark",
};

const THEME_KEY = "donkey-theme";
const listeners = new Set<() => void>();

const isPinned = (v: unknown): v is "light" | "dark" => v === "light" || v === "dark";

/** Runs inline in <head>: pins the saved theme before the body paints. */
export const THEME_HEAD_SCRIPT = `try{var t=localStorage.getItem(${JSON.stringify(THEME_KEY)});if(t==="light"||t==="dark"){document.documentElement.classList.add(t)}}catch(e){}`;

export function readTheme(): ThemeChoice {
  try {
    const saved = localStorage.getItem(THEME_KEY);
    return isPinned(saved) ? saved : "system";
  } catch {
    return "system";
  }
}

// Swap the root class: "system" clears both so the OS preference rules.
function applyTheme(choice: ThemeChoice) {
  const root = document.documentElement.classList;
  root.remove("light", "dark");
  if (isPinned(choice)) {
    root.add(choice);
  }
}

export function setTheme(choice: ThemeChoice) {
  try {
    if (isPinned(choice)) {
      localStorage.setItem(THEME_KEY, choice);
    } else {
      localStorage.removeItem(THEME_KEY);
    }
  } catch {
    // Storage blocked: the theme still applies for this page.
  }
  applyTheme(choice);
  listeners.forEach((l) => l());
}

/** Subscribes to theme changes here and in other tabs of this browser. */
export function subscribeTheme(listener: () => void) {
  const onStorage = (e: StorageEvent) => {
    if (e.key !== THEME_KEY) {
      return;
    }
    applyTheme(readTheme());
    listener();
  };

  listeners.add(listener);
  window.addEventListener("storage", onStorage);
  return () => {
    listeners.delete(listener);
    window.removeEventListener("storage", onStorage);
  };
}
