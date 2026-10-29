/**
 * Classic scrollbars — macOS with a mouse attached, Windows, Linux — take a
 * 15px gutter from every native scroller and draw a fat bar. The page flags
 * itself when they are in use, and the stylesheet draws them as the thin
 * ScrollArea hairline. Overlay scrollbars already float, so they stay native.
 */
export function markClassicScrollbars(doc: Document) {
  try {
    const probe = doc.createElement("div");
    probe.style.cssText = "position:absolute;top:-100px;width:50px;height:50px;overflow:scroll";
    doc.documentElement.appendChild(probe);
    if (probe.offsetWidth > probe.clientWidth) {
      doc.documentElement.dataset.scrollbars = "classic";
    }
    probe.remove();
  } catch {
    // A page that cannot measure keeps the native bars.
  }
}

/** The same check, run in the head so the first paint already has thin bars. */
export const SCROLLBARS_HEAD_SCRIPT = `(${markClassicScrollbars.toString()})(document)`;
