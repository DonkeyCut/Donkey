type PaneRect = { left: number; top: number; width: number; height: number };

/**
 * What the preview does when its pane changes: a camera still at its fit
 * refits on a change of size, so dragging the timeline panel grows or shrinks
 * the picture live. Otherwise the camera holds its screen position, or follows
 * the pane's center across when it sits centered horizontally.
 */
export function paneResize(
  prev: PaneRect,
  next: PaneRect,
  cam: { atFit: boolean; centeredX: boolean }
): { refit: true } | { refit: false; dx: number; dy: number } {
  const resized = prev.width !== next.width || prev.height !== next.height;
  if (cam.atFit && resized) return { refit: true };
  const dx = cam.centeredX ? 0 : prev.left + prev.width / 2 - (next.left + next.width / 2);
  const dy = prev.top + prev.height / 2 - (next.top + next.height / 2);
  return { refit: false, dx, dy };
}
