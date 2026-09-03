import { retimeOf, type Overlay } from "@donkeycut/effects-kit";
import type { VideoClip } from "./types";

// An element rides the frames of the clip under it. Its start and end are
// remembered as source seconds of that clip, so wherever those frames go —
// the clip moved, retimed, trimmed, split — the element goes over the same
// footage: a move carries it, a speed change stretches it with the picture,
// a trim leaves it on the frames it covered, and a split re-homes it to the
// half that now plays them. The store's write wrapper runs this on every
// write, transient drag frames included, so no edit path can leave a hosted
// element behind.

const EPS = 1e-6;
const NEAR = 1e-3;
const MIN_LEN = 0.1;

const spanEnd = (c: VideoClip) => c.start + retimeOf(c).len;

/** The clip whose frames sit under the element's middle; the highest track
 * wins, since that is the picture the element is drawn over. */
export function hostClipFor(
  clips: readonly VideoClip[],
  o: Pick<Overlay, "start" | "end">
): VideoClip | undefined {
  const mid = (o.start + o.end) / 2;
  let best: VideoClip | undefined;
  for (const c of clips) {
    if (mid < c.start - EPS || mid >= spanEnd(c) + EPS) continue;
    if (!best || c.track > best.track) best = c;
  }
  return best;
}

const spanChanged = (a: VideoClip, b: VideoClip) =>
  a.start !== b.start ||
  a.in !== b.in ||
  a.out !== b.out ||
  a.speed !== b.speed ||
  a.speedCurve !== b.speedCurve;

/** The element over the same source seconds of `host` that it covered of
 * `was`. The curve maps linearly past either end, so an element leading into
 * or trailing out of the clip keeps that lead. A stretched element scales its
 * keyed poses with it, so a key stays on the frame it was set on. */
function ride(o: Overlay, was: VideoClip, host: VideoClip): Overlay {
  const from = retimeOf(was);
  const to = retimeOf(host);
  let start = host.start + to.tAt(from.srcAt(o.start - was.start));
  let end = host.start + to.tAt(from.srcAt(o.end - was.start));
  if (end - start < MIN_LEN) end = start + MIN_LEN;
  if (start < 0) {
    end -= start;
    start = 0;
  }
  const scale = (end - start) / Math.max(EPS, o.end - o.start);
  const next: Overlay = { ...o, start, end };
  if (Math.abs(scale - 1) > EPS) {
    if (o.kf?.length) next.kf = o.kf.map((k) => ({ ...k, t: k.t * scale }));
    if (o.mask?.kf?.length)
      next.mask = { ...o.mask, kf: o.mask.kf.map((k) => ({ ...k, t: k.t * scale })) };
  }
  return next;
}

const near = (a: Pick<Overlay, "start" | "end">, b: Pick<Overlay, "start" | "end">) =>
  Math.abs(a.start - b.start) < NEAR && Math.abs(a.end - b.end) < NEAR;

/** Every element after a write: hosted ones carried with their host's frames,
 * placed ones and ones whose host went re-homed to the clip under them.
 * Null when the write changes nothing here. `carried` names the elements
 * this moved, for the caller to part the others clear of. */
export function settleOverlayHosts(
  prevClips: readonly VideoClip[],
  nextClips: readonly VideoClip[],
  prevOverlays: readonly Overlay[],
  nextOverlays: readonly Overlay[]
): { overlays: Overlay[]; carried: Set<string> } | null {
  if (prevClips === nextClips && prevOverlays === nextOverlays) return null;
  const prevClip = new Map(prevClips.map((c) => [c.id, c]));
  const nextClip = new Map(nextClips.map((c) => [c.id, c]));
  const prevOv = prevOverlays === nextOverlays ? null : new Map(prevOverlays.map((o) => [o.id, o]));
  const carried = new Set<string>();
  let changed = false;
  const overlays = nextOverlays.map((o) => {
    if (o.hostClipId === null) return o;
    const before = prevOv ? prevOv.get(o.id) : o;
    // The write positioned this element itself: it was created, or its span moved.
    const placed = !before || before.start !== o.start || before.end !== o.end;
    const host = o.hostClipId ? nextClip.get(o.hostClipId) : undefined;
    if (host && before) {
      const was = prevClip.get(host.id);
      if (was && spanChanged(was, host)) {
        const expected = ride(before, was, host);
        if (!placed) {
          // Its frames stayed put through a trim: nothing to carry.
          const landed = near(expected, before) ? o : expected;
          if (landed !== o) {
            carried.add(o.id);
            changed = true;
          }
          const mid = (landed.start + landed.end) / 2;
          if (mid >= host.start - EPS && mid < spanEnd(host) + EPS) return landed;
          // Its frames left the host — cut away, or split into another clip —
          // so it homes to the clip that plays them now.
          const id = hostClipFor(nextClips, landed)?.id;
          if (id === landed.hostClipId) return landed;
          changed = true;
          return { ...landed, hostClipId: id };
        }
        // A ripple moved the element with its footage already.
        if (near(expected, o)) return o;
        // Placed by hand while its host changed: it homes where it landed.
      } else if (!placed) {
        return o;
      }
    } else if (!placed && !o.hostClipId) {
      return o;
    }
    const id = hostClipFor(nextClips, o)?.id;
    if (id === o.hostClipId || (id === undefined && o.hostClipId === undefined)) return o;
    changed = true;
    return { ...o, hostClipId: id };
  });
  return changed ? { overlays, carried } : null;
}

/** A loaded document's elements homed to the clips under them, for docs from
 * before elements had hosts. Elements that already say stay as they say. */
export function adoptOverlayHosts(clips: readonly VideoClip[], overlays: readonly Overlay[]): Overlay[] {
  let changed = false;
  const next = overlays.map((o) => {
    if (o.hostClipId !== undefined) return o;
    const id = hostClipFor(clips, o)?.id;
    if (!id) return o;
    changed = true;
    return { ...o, hostClipId: id };
  });
  return changed ? next : (overlays as Overlay[]);
}
