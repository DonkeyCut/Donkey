// What the onboarding tours share for pointing at a control: finding it in
// view, waiting for it to show, keeping the highlight on it as the editor
// moves.

// What a control can scroll inside: the timeline and the app's scroll areas.
// A control scrolled out of one has left the highlight behind.
const SCROLLERS = "[data-tl-scroll], [data-slot='scroll-area-viewport']";

// How much of a control has to show each way to count as in view: nearly all
// of a small one, and this many px of a large one.
const IN_VIEW_SHARE = 0.9;
const IN_VIEW_PX = 80;

// The first match in view: a route left behind by instant navigation stays
// mounted with display:none, and its controls must not count.
export function shown(selector: string): Element | null {
  for (const el of document.querySelectorAll(selector)) {
    if (inView(el)) {
      return el;
    }
  }
  return null;
}

// Whether the control shows inside its scroller and the window, by enough to
// see and click it each way.
export function inView(el: Element, axes: "both" | "vertical" = "both"): boolean {
  if (!el.isConnected || !el.checkVisibility()) {
    return false;
  }
  const rect = el.getBoundingClientRect();
  const frames = [new DOMRect(0, 0, window.innerWidth, window.innerHeight)];
  const scroller = el.closest(SCROLLERS);
  if (scroller) {
    frames.push(scroller.getBoundingClientRect());
  }
  const enough = (shown: number, size: number) => shown >= Math.min(size * IN_VIEW_SHARE, IN_VIEW_PX);
  return frames.every(
    (frame) =>
      enough(Math.min(rect.bottom, frame.bottom) - Math.max(rect.top, frame.top), rect.height) &&
      (axes === "vertical" ||
        enough(Math.min(rect.right, frame.right) - Math.max(rect.left, frame.left), rect.width)),
  );
}

// Keeps the highlight on its control: a scroll, a resize or a re-render
// checks once per frame whether the control is still in view. `moved` redraws
// the highlight where it is now; `lost` fires when it has gone.
export function followTarget(target: Element, on: { moved: () => void; lost: () => void }): () => void {
  let frame = 0;
  const check = () => {
    frame = 0;
    if (inView(target)) {
      on.moved();
      return;
    }
    on.lost();
  };
  const schedule = () => {
    frame ||= window.requestAnimationFrame(check);
  };
  const resized = new ResizeObserver(schedule);
  resized.observe(target);
  const rendered = new MutationObserver(schedule);
  rendered.observe(document.body, { childList: true, subtree: true });
  document.addEventListener("scroll", schedule, { capture: true, passive: true });
  window.addEventListener("resize", schedule);
  return () => {
    window.cancelAnimationFrame(frame);
    resized.disconnect();
    rendered.disconnect();
    document.removeEventListener("scroll", schedule, { capture: true });
    window.removeEventListener("resize", schedule);
  };
}

// Resolves with the control once it shows, or null after `ms`.
export function waitForTarget(find: () => Element | null, ms: number, signal: AbortSignal): Promise<Element | null> {
  return new Promise((resolve) => {
    const hit = find();
    if (hit) {
      return resolve(hit);
    }
    const observer = new MutationObserver(() => {
      const el = find();
      if (el) {
        finish(el);
      }
    });
    const timer = window.setTimeout(() => finish(null), ms);
    const finish = (el: Element | null) => {
      observer.disconnect();
      window.clearTimeout(timer);
      signal.removeEventListener("abort", stop);
      resolve(el);
    };
    const stop = () => finish(null);
    signal.addEventListener("abort", stop);
    observer.observe(document.body, { attributes: true, childList: true, subtree: true });
  });
}

export const pause = (ms: number) => new Promise<void>((resolve) => window.setTimeout(resolve, ms));
