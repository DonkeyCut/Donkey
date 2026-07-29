// One contract shared by the settings row that replays the welcome sequence
// and the overlay mounted in the app shell that shows it. The overlay is
// mounted once, high in the tree; anything that wants it opens it from here.

const EVENT = "cut-onboarding-open";

export function openOnboarding(): void {
  window.dispatchEvent(new Event(EVENT));
}

export function onOpenOnboarding(handler: () => void): () => void {
  window.addEventListener(EVENT, handler);
  return () => window.removeEventListener(EVENT, handler);
}
