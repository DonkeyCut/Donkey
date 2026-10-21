/**
 * When an element is on screen.
 *
 * An element draws from its start up to its end, end excluded: the frame on
 * a cut belongs to the shot that starts there. The preview, the export and
 * the behind-the-speaker pass all ask here, so they draw the same elements
 * on every frame.
 */

/** How far inside the cut's end the stage draws a moment on the end. */
const END_HOLD = 0.001;

/** Whether an element draws at `t`. One ending at 2 and one starting at 2
 * meet on that frame, and the frame shows the second alone. */
export function overlayLiveAt(o: { start: number; end: number }, t: number): boolean {
  return t >= o.start && t < o.end;
}

/**
 * The moment the stage draws for a playhead at `t`, in a cut `total` long.
 * Playback stops with the playhead on the end, a moment past the final shot,
 * so the stage draws the moment just inside it: paused there, the picture is
 * the cut's last frame, with every element that runs to the end.
 */
export function stageTimeAt(t: number, total: number): number {
  return Math.max(0, Math.min(t, total - END_HOLD));
}
