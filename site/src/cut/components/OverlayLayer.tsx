"use client";

import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import { startDrag } from "@/cut/lib/drag";
import { useEditor } from "@/cut/lib/store";
import {
  captionStyle,
  cueAt,
  cueOverlay,
  cueWordWindows,
  karaokeLook,
  laneCues,
  laneHidden,
  subtitleLaneCount,
  trackPos,
} from "@/cut/lib/subtitles";
import { evalOverlayFrame, hasMaskKeys, hasOverlayKeys, isOverlayAnimated, lineLikeShape, maskFrameAt, paintMaskCoverage, resolveShadow, shapeMetrics, shapePathD, type LottieHandle, type MaskKey } from "@donkeycut/effects-kit";
import {
  LINE_HEIGHT,
  PLATE_PAD_X,
  PLATE_PAD_Y,
  PLATE_RADIUS,
  plateFill,
  SHADOW,
} from "@/cut/lib/textRender";
import {
  behindSubjectOverlay,
  clampOverlayPos,
  frameOf,
  fontStack,
  isTextOverlay,
  laneOf,
  type Overlay,
  type OverlayPatch,
  type ShapeOverlay,
  type StickerOverlay,
} from "@/cut/lib/types";
import { subjectMatteSnapshot } from "@/cut/lib/behindPass";
import { cn } from "@/lib/utils";

// Plate geometry as CSS, kept in lockstep with the export burn-in metrics.
const PLATE_PADDING = `${PLATE_PAD_Y}em ${PLATE_PAD_X}em`;
const PLATE_RADIUS_EM = `${PLATE_RADIUS}em`;

/**
 * The rotate handle's cursor. CSS has no rotate cursor, so the affordance is
 * drawn here — and because the glyph is an arc with a head at each end rather
 * than a full circle, which way it faces carries meaning: it is turned to sit
 * tangent to the element, so the heads always point the way a drag will take
 * it. White over a dark rim keeps it legible on any footage.
 */
const ROTATE_GLYPH_W = 59;
const ROTATE_GLYPH_H = 90;
const ROTATE_GLYPH =
  "M58.202 82.4995C57.967 81.6525 57.086 81.1635 56.239 81.3945L40.985 85.6485C46.122 77.9215 48.929 68.7815 48.929 59.4355C48.929 34.8625 30.107 14.6195 6.125 12.3295L18.995 2.88146C19.705 2.35846 19.857 1.36246 19.336 0.652464C18.815 -0.0575359 17.82 -0.213536 17.108 0.310464L0.65 12.3935C0.601 12.4295 0.576001 12.4825 0.533001 12.5225C0.480001 12.5705 0.437001 12.6245 0.391001 12.6795C0.306001 12.7815 0.230999 12.8825 0.174999 12.9995C0.138999 13.0715 0.118 13.1475 0.0939999 13.2255C0.0589999 13.3415 0.0320002 13.4545 0.0240002 13.5755C0.0210002 13.6165 0 13.6525 0 13.6945C0 13.7585 0.0289993 13.8125 0.0359993 13.8735C0.0479993 13.9695 0.0630004 14.0605 0.0930004 14.1545C0.133 14.2855 0.19 14.4015 0.261 14.5155C0.282 14.5495 0.285999 14.5885 0.309999 14.6215L12.391 31.0785C12.702 31.5055 13.186 31.7295 13.677 31.7295C14.004 31.7295 14.334 31.6295 14.619 31.4215C15.329 30.8985 15.481 29.9025 14.96 29.1925L4.873 15.4545C27.685 17.1435 45.741 36.1995 45.741 59.4355C45.741 68.5495 42.879 77.4515 37.663 84.8545L33.051 68.3205C32.814 67.4735 31.932 66.9815 31.088 67.2155C30.24 67.4525 29.745 68.3305 29.981 69.1805L35.467 88.8445C35.474 88.8695 35.494 88.8895 35.502 88.9135C35.551 89.0595 35.618 89.1925 35.709 89.3215C35.745 89.3735 35.785 89.4185 35.827 89.4665C35.88 89.5255 35.912 89.5965 35.975 89.6485C36.03 89.6935 36.096 89.7135 36.155 89.7495C36.179 89.7645 36.194 89.7895 36.218 89.8035C36.237 89.8145 36.261 89.8095 36.281 89.8205C36.505 89.9325 36.742 90.0095 36.984 90.0095C36.987 90.0095 36.99 90.0075 36.993 90.0075C36.996 90.0075 36.998 90.0095 37.001 90.0095C37.144 90.0095 37.289 89.9905 37.429 89.9505L57.095 84.4645C57.944 84.2275 58.439 83.3495 58.202 82.4995Z";
/** A square the glyph fits inside at any angle, so turning it never clips. */
const ROTATE_BOX = Math.ceil(Math.hypot(ROTATE_GLYPH_W, ROTATE_GLYPH_H));
/** The glyph's own arrows run top-to-bottom, so a quarter turn puts them
 * left-to-right — the way an unrotated element's top handle drags. */
const ROTATE_BASE_DEG = -90;

const rotateCursorCache = new Map<number, string>();

function rotateCursor(rotationDeg: number): string {
  // Quantized: a drag would otherwise mint a new cursor image every frame, and
  // five degrees is below what the eye reads on a glyph this size.
  const deg = Math.round((rotationDeg + ROTATE_BASE_DEG) / 5) * 5;
  const hit = rotateCursorCache.get(deg);
  if (hit) return hit;
  const c = ROTATE_BOX / 2;
  const dx = (ROTATE_BOX - ROTATE_GLYPH_W) / 2;
  const dy = (ROTATE_BOX - ROTATE_GLYPH_H) / 2;
  const layer = (attrs: string) =>
    `<g transform='rotate(${deg} ${c} ${c}) translate(${dx} ${dy})'><path d='${ROTATE_GLYPH}' ${attrs}/></g>`;
  const svg =
    `<svg xmlns='http://www.w3.org/2000/svg' width='32' height='32' viewBox='0 0 ${ROTATE_BOX} ${ROTATE_BOX}'>` +
    `${layer("fill='none' stroke='rgba(0,0,0,0.55)' stroke-width='10' stroke-linejoin='round'")}` +
    `${layer("fill='%23ffffff'")}</svg>`;
  const css = `url("data:image/svg+xml;utf8,${svg}") 16 16, grab`;
  rotateCursorCache.set(deg, css);
  return css;
}

/** Snap when a title edge/center lands within this many stage px of a line. */
const SNAP_PX = 6;
/** Safe-area inset (fraction of the frame) offered as margin snap lines. */
const CANVAS_MARGIN = 0.05;

/** Active alignment guides, as stage-pixel positions. */
interface Guides {
  v: number[]; // vertical lines (x)
  h: number[]; // horizontal lines (y)
}

/** A subtitle track's key in the shared snap-box registry. Overlay ids are
 * uids, so these can't collide. */
const subtitleBoxId = (lane: number) => `subtitle-caption-${lane}`;

export function OverlayLayer({
  stageWidth,
  transform,
  filter,
  from = 0,
  to = Infinity,
  captions = true,
}: {
  stageWidth: number;
  /** How a live effect moves the frame (shake, tearing) — the elements travel
   * with the picture they sit on. */
  transform?: string;
  /** The grade of every effect above these elements. An effect filters what
   * plays under it, so the ones below it wear its look and the ones above it
   * do not (see StageEffects). */
  filter?: string;
  /** The lanes this slice of the stack draws: [from, to). */
  from?: number;
  to?: number;
  /** Captions ride the topmost slice; nothing grades them. */
  captions?: boolean;
}) {
  const allOverlays = useEditor((s) => s.overlays);
  const overlays = useMemo(
    () => allOverlays.filter((o) => laneOf(o) >= from && laneOf(o) < to),
    [allOverlays, from, to]
  );
  const currentTime = useEditor((s) => s.currentTime);
  const skimTime = useEditor((s) => s.skimTime);
  const playing = useEditor((s) => s.playing);
  const selection = useEditor((s) => s.selection);
  const aspect = useEditor((s) => s.aspect);
  // Titles preview under the skimmer too (paused only), matching the canvas.
  const t = !playing && skimTime !== null ? skimTime : currentTime;

  const rootRef = useRef<HTMLDivElement>(null);
  // Live box elements per on-screen item (titles and the subtitle caption), so
  // a dragged one can align to the others that are on screen at the same time.
  const boxes = useRef<Map<string, HTMLElement>>(new Map());
  const [guides, setGuides] = useState<Guides>({ v: [], h: [] });
  const registerBox = useCallback((id: string, el: HTMLElement | null) => {
    if (el) boxes.current.set(id, el);
    else boxes.current.delete(id);
  }, []);

  const frame = frameOf(aspect);
  const stageHeight = (stageWidth * frame.h) / frame.w;

  // Smart snapping: while dragging an item, pull its left/center/
  // right edges to the frame edges, safe margins, center line, and the edges
  // and centers of the other on-screen items — independently per axis — and
  // paint the matched guide lines. Hold ⌘/Ctrl to bypass.
  const snap = useCallback(
    (id: string, px: number, py: number, ev: PointerEvent): { x: number; y: number } => {
      const el = boxes.current.get(id);
      const root = rootRef.current;
      if (!el || !root || ev.metaKey || ev.ctrlKey) {
        setGuides({ v: [], h: [] });
        return { x: px, y: py };
      }
      const r = el.getBoundingClientRect();
      const cx = px * stageWidth;
      const cy = py * stageHeight;
      // Frame lines: edges, safe margins, center.
      const vt = [0, CANVAS_MARGIN * stageWidth, stageWidth / 2, (1 - CANVAS_MARGIN) * stageWidth, stageWidth];
      const ht = [0, CANVAS_MARGIN * stageHeight, stageHeight / 2, (1 - CANVAS_MARGIN) * stageHeight, stageHeight];
      // Plus every other on-screen box's edges and center (titles and the
      // subtitle caption alike), read from its rect in stage space.
      const rootRect = root.getBoundingClientRect();
      for (const [bid, e] of boxes.current) {
        if (bid === id) continue;
        const rr = e.getBoundingClientRect();
        const left = rr.left - rootRect.left;
        const top = rr.top - rootRect.top;
        vt.push(left, left + rr.width / 2, left + rr.width);
        ht.push(top, top + rr.height / 2, top + rr.height);
      }
      // For one axis, snap the closest of {near edge, center, far edge} to the
      // closest target line, returning the shifted center and the matched line.
      const pick = (anchors: number[], offsets: number[], targets: number[]) => {
        let best = { d: SNAP_PX + 1, center: NaN, line: NaN };
        anchors.forEach((a, i) => {
          for (const T of targets) {
            const d = Math.abs(a - T);
            if (d < best.d) best = { d, center: T - offsets[i], line: T };
          }
        });
        return best;
      };
      const bx = pick([cx - r.width / 2, cx, cx + r.width / 2], [-r.width / 2, 0, r.width / 2], vt);
      const by = pick([cy - r.height / 2, cy, cy + r.height / 2], [-r.height / 2, 0, r.height / 2], ht);
      const v: number[] = [];
      const h: number[] = [];
      let outX = px;
      let outY = py;
      if (!Number.isNaN(bx.center)) {
        outX = bx.center / stageWidth;
        v.push(bx.line);
      }
      if (!Number.isNaN(by.center)) {
        outY = by.center / stageHeight;
        h.push(by.line);
      }
      setGuides({ v, h });
      return { x: outX, y: outY };
    },
    [stageWidth, stageHeight]
  );

  const clearGuides = useCallback(() => setGuides({ v: [], h: [] }), []);

  // The selected title and whether the playhead sits inside it. Selecting a
  // title off the playhead (e.g. focusing its text in the panel) edits it in
  // isolation: it shows alone so it never stacks over whatever title is live.
  // Not while scrubbing — the skimmer must still show the exact frame's titles.
  const scrubbing = !playing && skimTime !== null;
  const sel =
    selection?.kind === "overlay" ? overlays.find((o) => o.id === selection.id) : undefined;
  const isolate = !!sel && !scrubbing && !(t >= sel.start && t <= sel.end);

  return (
    <div
      ref={rootRef}
      className="pointer-events-none absolute inset-0"
      style={{ transform, filter }}
    >
      {captions && (
        <SubtitleCaptions
          stageWidth={stageWidth}
          stageHeight={stageHeight}
          registerBox={registerBox}
          snap={snap}
          onSnapEnd={clearGuides}
        />
      )}
      {overlays.map((o) => {
        if (o.hidden) return null;
        // An effect has no place in the frame — it grades what plays under it
        // (see StageEffects), so it draws nothing here and takes no box,
        // handles or drag. The timeline bar is the thing you grab.
        if (o.kind === "effect") return null;
        const selected = sel?.id === o.id;
        const inRange = t >= o.start && t <= o.end;
        // While hover-scrubbing (paused, skimmer active) the preview must show the
        // exact frame under the skimmer — a selected but out-of-frame title can't
        // leak into a frame it isn't part of. Off the skimmer, a selected title
        // that sits off the playhead is shown alone (isolate) for editing.
        if (isolate ? !selected : !inRange && (scrubbing || !selected)) return null;
        return (
          <OverlayItem
            key={o.id}
            overlay={o}
            // The skimmer paints the bare frame: the item still renders, its
            // selection chrome (outline, resize handle) does not.
            selected={selected && !scrubbing}
            ghost={!inRange && !selected}
            t={t}
            stageWidth={stageWidth}
            registerBox={registerBox}
            snap={snap}
            onSnapEnd={clearGuides}
          />
        );
      })}
      {guides.v.map((x, i) => (
        <div
          key={`v${i}`}
          className="pointer-events-none absolute top-0 bottom-0 z-10 w-px bg-[#ff2d55]"
          style={{ left: x }}
        />
      ))}
      {guides.h.map((y, i) => (
        <div
          key={`h${i}`}
          className="pointer-events-none absolute right-0 left-0 z-10 h-px bg-[#ff2d55]"
          style={{ top: y }}
        />
      ))}
    </div>
  );
}

/** Every subtitle track's active cue, one caption per language. */
function SubtitleCaptions(props: {
  stageWidth: number;
  stageHeight: number;
  registerBox: (id: string, el: HTMLElement | null) => void;
  snap: (id: string, x: number, y: number, ev: PointerEvent) => { x: number; y: number };
  onSnapEnd: () => void;
}) {
  const subtitles = useEditor((s) => s.subtitles);
  if (!subtitles.showOnVideo) return null;
  return (
    <>
      {Array.from({ length: subtitleLaneCount(subtitles) }, (_, lane) =>
        laneHidden(subtitles, lane) ? null : (
          <SubtitleCaption key={lane} lane={lane} {...props} />
        )
      )}
    </>
  );
}

/** One track's active cue, rendered exactly like the export burn-in.
 * Nothing renders when there is no cue at the playhead (no speech). Dragging
 * the caption moves the whole track — the position is one per-track anchor,
 * not per-cue — and rides the same smart snapping and guide lines as titles. */
function SubtitleCaption({
  lane,
  stageWidth,
  stageHeight,
  registerBox,
  snap,
  onSnapEnd,
}: {
  lane: number;
  stageWidth: number;
  stageHeight: number;
  registerBox: (id: string, el: HTMLElement | null) => void;
  snap: (id: string, x: number, y: number, ev: PointerEvent) => { x: number; y: number };
  onSnapEnd: () => void;
}) {
  const subtitles = useEditor((s) => s.subtitles);
  const currentTime = useEditor((s) => s.currentTime);
  const skimTime = useEditor((s) => s.skimTime);
  const playing = useEditor((s) => s.playing);
  const frame = frameOf(useEditor((s) => s.aspect));
  const t = !playing && skimTime !== null ? skimTime : currentTime;

  const cues = laneCues(subtitles, lane);
  const cue = cueAt(cues, t);
  if (!cue || !cue.text.trim()) return null;

  // Captions ride the same style/opener/anchor logic as the export burn-in,
  // so the preview and the rendered file match exactly.
  const style = captionStyle(subtitles.style);
  const ov = cueOverlay(
    cue,
    style,
    cue.id === cues[0]?.id,
    trackPos(subtitles, style, lane),
    undefined,
    frame.w
  );
  // Karaoke: the word under the playhead lights up as it is spoken.
  const wordIndex = subtitles.wordHighlight
    ? cueWordWindows(cue).findIndex((w) => t >= w.start && t < w.end)
    : -1;
  // The spoken word's treatment follows the style (with user overrides): an
  // accent box (drawn with box-shadow spread so the line never reflows), the
  // accent color alone, or accent color + underline.
  const look = karaokeLook(style, subtitles);
  const activeStyle: CSSProperties =
    look.mode === "box"
      ? {
          color: look.text,
          background: look.color,
          boxShadow: `0 0 0 0.12em ${look.color}`,
          borderRadius: "0.18em",
          textShadow: "none",
        }
      : look.mode === "color"
        ? { color: look.color }
        : {
            color: look.color,
            textDecoration: "underline",
            textDecorationThickness: "0.07em",
            textUnderlineOffset: "0.14em",
          };
  const scale = stageWidth / frame.w;
  return (
    <div
      ref={(el) => registerBox(subtitleBoxId(lane), el)}
      className="sub-caption pointer-events-auto absolute -translate-x-1/2 -translate-y-1/2 cursor-grab text-center whitespace-pre-wrap active:cursor-grabbing"
      onPointerDown={(e) => {
        const s = useEditor.getState();
        s.pushHistory();
        const { x: x0, y: y0 } = ov;
        startDrag(e, {
          onMove: (dx, dy, ev) => {
            const p = snap(subtitleBoxId(lane), x0 + dx / stageWidth, y0 + dy / stageHeight, ev);
            useEditor.getState().setSubtitleTrackMeta(lane, {
              x: Math.min(0.98, Math.max(0.02, p.x)),
              y: Math.min(0.98, Math.max(0.02, p.y)),
            });
          },
          onUp: onSnapEnd,
        });
      }}
      style={{
        left: `${ov.x * 100}%`,
        top: `${ov.y * 100}%`,
        // Hard cap at the safe area so a caption can never spill past the
        // frame edge, even if a line slips past the wrap estimate.
        maxWidth: `${0.9 * stageWidth}px`,
        fontSize: ov.size * scale,
        fontFamily: fontStack(ov.font),
        fontWeight: ov.weight,
        lineHeight: LINE_HEIGHT,
        color: ov.color,
        textShadow: ov.shadow
          ? `0 ${SHADOW.offsetY * scale}px ${SHADOW.blur * scale}px ${SHADOW.color}`
          : undefined,
        background: ov.plate ? plateFill(ov) : undefined,
        padding: ov.plate ? PLATE_PADDING : undefined,
        borderRadius: ov.plate ? PLATE_RADIUS_EM : undefined,
      }}
    >
      {wordIndex < 0
        ? ov.text
        : (() => {
            let k = 0;
            return ov.text.split("\n").map((line, li) => (
              <span key={li} className="block">
                {line.split(" ").map((w, wi) => {
                  const active = k === wordIndex;
                  k++;
                  return (
                    <span key={wi}>
                      {wi > 0 && " "}
                      <span style={active ? activeStyle : undefined}>{w}</span>
                    </span>
                  );
                })}
              </span>
            ));
          })()}
    </div>
  );
}

function OverlayItem({
  overlay: o,
  selected,
  ghost,
  t,
  stageWidth,
  registerBox,
  snap,
  onSnapEnd,
}: {
  overlay: Overlay;
  selected: boolean;
  ghost: boolean;
  /** The previewed timeline moment (playhead or paused skimmer). */
  t: number;
  stageWidth: number;
  registerBox: (id: string, el: HTMLElement | null) => void;
  snap: (id: string, x: number, y: number, ev: PointerEvent) => { x: number; y: number };
  onSnapEnd: () => void;
}) {
  const [editing, setEditing] = useState(false);
  const editRef = useRef<HTMLDivElement>(null);
  const boxRef = useRef<HTMLDivElement>(null);
  const frame = frameOf(useEditor((s) => s.aspect));
  const scale = stageWidth / frame.w;
  const stageHeight = (stageWidth * frame.h) / frame.w;
  const isText = isTextOverlay(o);

  // Publish this element's box so a sibling drag can align to it.
  useEffect(() => {
    registerBox(o.id, boxRef.current);
    return () => registerBox(o.id, null);
  }, [o.id, registerBox]);

  useEffect(() => {
    if (editing && editRef.current) {
      editRef.current.focus();
      const range = document.createRange();
      range.selectNodeContents(editRef.current);
      const sel = window.getSelection();
      sel?.removeAllRanges();
      sel?.addRange(range);
    }
  }, [editing]);

  // The element's animation state at this exact moment — the same evaluator
  // the export samples, applied here as a live CSS transform. Ghosts (shown
  // out of range for editing) render at rest.
  const live = !ghost && isOverlayAnimated(o) ? evalOverlayFrame(o, Math.max(0, t - o.start)) : null;
  const animTransform = live
    ? ` translate(${live.dx * scale}px, ${live.dy * scale}px)` +
      (live.rotation ? ` rotate(${live.rotation}deg)` : "") +
      (live.scale !== 1 ? ` scale(${live.scale})` : "")
    : o.rotation
      ? ` rotate(${o.rotation}deg)`
      : "";
  // Typewriter: the visible slice of the text (display only, never while
  // the box is being edited).
  const shownText =
    isText && live?.textProgress !== undefined && !editing
      ? o.text.slice(0, Math.ceil(live.textProgress * o.text.length))
      : isText
        ? o.text
        : "";
  // Behind-the-speaker elements draw inside the canvas compositor; the DOM
  // keeps an invisible hit target (and the selection chrome) so editing
  // still works.
  const behindHidden = behindSubjectOverlay(o) && !editing;

  const tLocal = Math.max(0, t - o.start);
  // The mask clips the content wrapper only, never the box itself — the
  // selection chrome and the mask's own grips must stay visible outside it.
  const maskCss = useMaskCss(o, boxRef, stageWidth, stageHeight, scale, tLocal, editing);

  // The box carries position, rotation, and opacity; the content wrapper
  // inside it carries a title's type styles (the edit caret inherits them)
  // and the mask.
  const style: CSSProperties = {
    // A keyframed element is placed by its pose, not by its resting x/y.
    left: `${(live?.x ?? o.x) * 100}%`,
    top: `${(live?.y ?? o.y) * 100}%`,
    transform: `translate(-50%, -50%)${animTransform}`,
    opacity: (live ? live.opacity : (o.opacity ?? 1)) * (ghost ? 0.35 : 1),
  };
  const contentStyle: CSSProperties = {
    ...(isText
      ? (() => {
          const shadow = resolveShadow(o.shadow);
          return {
            fontSize: o.size * scale,
            fontFamily: fontStack(o.font),
            fontWeight: o.weight,
            fontStyle: o.italic ? "italic" : undefined,
            lineHeight: o.lineHeight ?? LINE_HEIGHT,
            letterSpacing: o.letterSpacing ? `${o.letterSpacing}em` : undefined,
            textAlign: o.align ?? "center",
            color: o.color,
            // The canvas pair strokes before filling; paint-order keeps the
            // DOM stroke behind the fill the same way. `width` is the visible
            // outline outside the glyph, so the centered CSS stroke doubles it
            // (the canvas painter doubles its lineWidth identically).
            WebkitTextStroke: o.stroke
              ? `${o.stroke.width * 2}em ${o.stroke.color}`
              : undefined,
            paintOrder: o.stroke ? ("stroke fill" as const) : undefined,
            textShadow: shadow
              ? `0 ${shadow.offsetY * scale}px ${shadow.blur * scale}px ${shadow.color}`
              : undefined,
            // A behind-speaker title paints on the canvas; the DOM box keeps
            // its footprint but no visible plate.
            background: o.plate && !behindHidden ? plateFill(o) : undefined,
            padding: o.plate ? PLATE_PADDING : undefined,
            borderRadius: o.plate ? `${o.plateRadius ?? PLATE_RADIUS}em` : undefined,
          };
        })()
      : {}),
    ...(maskCss ?? {}),
  };

  const commitText = () => {
    if (!isText) return;
    const text = (editRef.current?.innerText ?? "").replace(/\n+$/, "");
    setEditing(false);
    if (text !== o.text) {
      const s = useEditor.getState();
      s.pushHistory();
      s.updateOverlayTransient(o.id, { text: text || "Your text" });
    }
  };

  // A single click anywhere outside the editable box commits and dismisses it,
  // so text doesn't stay "stuck" in edit mode when the click misses focus.
  useEffect(() => {
    if (!editing) return;
    const onDown = (e: PointerEvent) => {
      if (!editRef.current?.contains(e.target as Node)) commitText();
    };
    document.addEventListener("pointerdown", onDown, true);
    return () => document.removeEventListener("pointerdown", onDown, true);
    // commitText closes over the current overlay; re-bind when editing toggles.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [editing]);

  /** The whole group's live members (or just this element), snapshotted at a
   * gesture's start so deltas apply member-relative. */
  const groupSnapshot = () => {
    const all = useEditor.getState().overlays;
    return o.groupId ? all.filter((x) => x.groupId === o.groupId) : [o];
  };
  const clampPos = clampOverlayPos;

  /**
   * Commit a live transform. Position and rotation are pose: on a keyframed
   * element they land in the key at the playhead — which is what makes
   * dragging in the preview the way you author motion — while everything else
   * (a font size, a shape's box) is the element's own and always patches it.
   */
  const writeTransform = (
    patches: { id: string; patch: { x?: number; y?: number; rotation?: number } }[]
  ) => {
    const s = useEditor.getState();
    const direct: { id: string; patch: OverlayPatch }[] = [];
    for (const { id, patch } of patches) {
      const el = s.overlays.find((x) => x.id === id);
      const { x, y, rotation, ...rest } = patch;
      const posed = x !== undefined || y !== undefined || "rotation" in patch;
      if (el && posed && hasOverlayKeys(el)) {
        s.setOverlayKey(
          id,
          Math.max(0, Math.min(t - el.start, Math.max(0.1, el.end - el.start))),
          {
            ...(x !== undefined ? { x } : {}),
            ...(y !== undefined ? { y } : {}),
            // A key stores its angle outright; absence means zero only on the
            // element itself.
            ...("rotation" in patch ? { rotation: rotation ?? 0 } : {}),
          },
          { transient: true }
        );
        if (Object.keys(rest).length) direct.push({ id, patch: rest as OverlayPatch });
        continue;
      }
      direct.push({ id, patch: patch as OverlayPatch });
    }
    if (direct.length) s.updateOverlaysTransient(direct);
  };

  // The corner handle resizes what the kind actually stores: a title's font
  // size, a shape's box (both axes by the drag ratio), a sticker's width.
  // A group scales as one: every member's size and its offset from the group
  // center ride the same factor.
  const resizeFrom = (e: React.PointerEvent) => {
    const s = useEditor.getState();
    s.pushHistory();
    const box = boxRef.current!.getBoundingClientRect();
    const cx = box.left + box.width / 2;
    const cy = box.top + box.height / 2;
    const d0 = Math.max(8, Math.hypot(e.clientX - cx, e.clientY - cy));
    const members = groupSnapshot();
    const gx = members.reduce((sum, m) => sum + m.x, 0) / members.length;
    const gy = members.reduce((sum, m) => sum + m.y, 0) / members.length;
    const scaled = (m: Overlay, k: number): Partial<Overlay> => {
      if (isTextOverlay(m)) {
        return { size: Math.round(Math.min(320, Math.max(16, m.size * k))) };
      }
      if (m.kind === "shape") {
        return {
          w: Math.min(2, Math.max(0.01, m.w * k)),
          h: Math.min(2, Math.max(0.002, m.h * k)),
        };
      }
      if (m.kind === "sticker") return { w: Math.min(1.5, Math.max(0.02, m.w * k)) };
      return {};
    };
    startDrag(e, {
      onMove: (_dx, _dy, ev) => {
        const k = Math.hypot(ev.clientX - cx, ev.clientY - cy) / d0;
        writeTransform(
          members.map((m) => ({
            id: m.id,
            patch: {
              ...scaled(m, k),
              ...(members.length > 1
                ? { x: clampPos(gx + (m.x - gx) * k), y: clampPos(gy + (m.y - gy) * k) }
                : {}),
            },
          }))
        );
      },
    });
  };

  // The lollipop above the box rotates around the center; plain angles within
  // 3° of a quarter turn snap to it, and 0 stores as absence. A group orbits
  // its shared center: positions revolve and each member's rotation shifts by
  // the same delta.
  const rotateFrom = (e: React.PointerEvent) => {
    const s = useEditor.getState();
    s.pushHistory();
    const box = boxRef.current!.getBoundingClientRect();
    const cx = box.left + box.width / 2;
    const cy = box.top + box.height / 2;
    const members = groupSnapshot();
    const gx = members.reduce((sum, m) => sum + m.x, 0) / members.length;
    const gy = members.reduce((sum, m) => sum + m.y, 0) / members.length;
    const angleAt = (ev: { clientX: number; clientY: number }) =>
      (Math.atan2(ev.clientY - cy, ev.clientX - cx) * 180) / Math.PI + 90;
    const start0 = angleAt(e);
    const norm = (deg: number) => ((((deg + 180) % 360) + 360) % 360) - 180;
    // The cursor turns with the element for the whole drag, so its heads keep
    // pointing the way the next bit of travel will take it.
    let liveRotation = o.rotation ?? 0;
    startDrag(e, {
      cursor: () => rotateCursor(liveRotation),
      onMove: (_dx, _dy, ev) => {
        if (members.length === 1) {
          let deg = norm(angleAt(ev));
          for (const q of [-180, -90, 0, 90, 180]) {
            if (Math.abs(deg - q) < 3) deg = q;
          }
          const rotation = Math.round(deg);
          liveRotation = rotation;
          writeTransform([{ id: o.id, patch: { rotation: rotation === 0 ? undefined : rotation } }]);
          return;
        }
        const delta = norm(angleAt(ev) - start0);
        liveRotation = norm((o.rotation ?? 0) + delta);
        const rad = (delta * Math.PI) / 180;
        // Positions are frame fractions with unequal axes; orbit in a square
        // space keyed to width so the group turns rigidly on screen.
        const ax = 1;
        const ay = stageHeight / stageWidth;
        writeTransform(
          members.map((m) => {
            const ox = (m.x - gx) * ax;
            const oy = (m.y - gy) * ay;
            const rotation = Math.round(norm((m.rotation ?? 0) + delta));
            return {
              id: m.id,
              patch: {
                x: clampPos(gx + (ox * Math.cos(rad) - oy * Math.sin(rad)) / ax),
                y: clampPos(gy + (ox * Math.sin(rad) + oy * Math.cos(rad)) / ay),
                rotation: rotation === 0 ? undefined : rotation,
              },
            };
          })
        );
      },
    });
  };

  return (
    <div
      ref={boxRef}
      className={cn(
        "overlay-item pointer-events-auto absolute cursor-grab rounded-xs text-center whitespace-pre active:cursor-grabbing",
        selected && "outline-[1.5px] outline-offset-[3px] outline-[#0a84ff]",
        editing && "cursor-text"
      )}
      style={style}
      onPointerDown={(e) => {
        if (editing) return;
        const s = useEditor.getState();
        s.select({ kind: "overlay", id: o.id });
        s.pushHistory();
        // A grouped element drags its whole group: the grabbed one snaps, the
        // rest follow by the same delta.
        const members = groupSnapshot().map((m) => ({ id: m.id, x: m.x, y: m.y }));
        const self = members.find((m) => m.id === o.id) ?? { id: o.id, x: o.x, y: o.y };
        startDrag(e, {
          onMove: (dx, dy, ev) => {
            const p = snap(o.id, self.x + dx / stageWidth, self.y + dy / stageHeight, ev);
            const ddx = clampPos(p.x) - self.x;
            const ddy = clampPos(p.y) - self.y;
            writeTransform(
              members.map((m) => ({
                id: m.id,
                patch: { x: clampPos(m.x + ddx), y: clampPos(m.y + ddy) },
              }))
            );
          },
          onUp: onSnapEnd,
        });
      }}
      onDoubleClick={isText ? () => setEditing(true) : undefined}
    >
      <div style={contentStyle}>
        {behindHidden ? (
          <span className="opacity-0">{shownText}</span>
        ) : isText ? (
          editing ? (
            <div
              ref={editRef}
              className="min-w-2 outline-none select-text"
              contentEditable
              suppressContentEditableWarning
              onBlur={commitText}
              onKeyDown={(e) => {
                if (e.key === "Escape") {
                  e.preventDefault();
                  commitText();
                }
                e.stopPropagation();
              }}
            >
              {o.text}
            </div>
          ) : (
            <span>{shownText}</span>
          )
        ) : o.kind === "shape" ? (
          <ShapeView shape={o} stageWidth={stageWidth} stageHeight={stageHeight} scale={scale} />
        ) : o.kind === "sticker" ? (
          <StickerView sticker={o} stageWidth={stageWidth} t={t} />
        ) : null}
      </div>
      {selected && !editing && (
        <>
          {/* The grab zone is wider than the dot, so the rotate cursor shows
              as the pointer approaches rather than only dead on it. It clears
              the element's own top edge, so moving is never caught by it. */}
          <span
            title="Drag to rotate"
            className="overlay-rotate absolute -top-8 left-1/2 grid size-7 -translate-x-1/2 place-items-center"
            // The handle rides the element's rotation, so the cursor turns
            // with it and its heads keep pointing along the drag.
            style={{ cursor: rotateCursor(live?.rotation ?? o.rotation ?? 0) }}
            onPointerDown={rotateFrom}
          >
            <span className="size-[13px] rounded-full border-[2.5px] border-[#0a84ff] bg-white shadow-[0_1px_4px_rgba(0,0,0,0.4)]" />
          </span>
          <span
            title="Drag to resize"
            className="overlay-resize absolute -right-2 -bottom-2 size-[13px] cursor-nwse-resize rounded-full border-[2.5px] border-[#0a84ff] bg-white shadow-[0_1px_4px_rgba(0,0,0,0.4)]"
            onPointerDown={resizeFrom}
          />
          {o.mask && o.mask.kind !== "subject" && (
            <MaskGizmo
              overlay={o}
              stageWidth={stageWidth}
              stageHeight={stageHeight}
              tLocal={tLocal}
              rotation={live?.rotation ?? o.rotation ?? 0}
              poseScale={live?.scale ?? 1}
            />
          )}
        </>
      )}
    </div>
  );
}

/**
 * The element's mask as CSS: the kit painter draws its coverage on a small
 * box-sized canvas, and the data URL becomes the content's mask-image. The
 * mask lives in the element's own space — the box's CSS transform carries it
 * through pose, rotation and scale — so it clips exactly where the exported
 * raster clips. Regenerated when the geometry, the box, or (keyed) the
 * playhead moves; disabled while the text is being edited.
 */
/** A keyed mask's CSS repaints on the matte cadence — enough for a soft
 * moving edge, a quarter of the per-frame PNG encodes. */
const MASK_CSS_FPS = 15;
/** The mask canvas's size cap; the CSS mask stretches it over the box, so a
 * big element pays a small encode. */
const MASK_CSS_MAX = 512;
/** Empty coverage: hides the element while a computed matte has no person. */
const NO_COVERAGE_MASK = "linear-gradient(transparent, transparent)";

function useMaskCss(
  o: Overlay,
  boxRef: React.RefObject<HTMLDivElement | null>,
  stageWidth: number,
  stageHeight: number,
  scale: number,
  tLocal: number,
  disabled: boolean
): CSSProperties | undefined {
  const m = o.mask;
  // A behind (inverted subject) element renders in the canvas pass; the DOM
  // masks shapes and front subject elements.
  const subjectFront = !!m && m.kind === "subject" && !m.invert;
  const active = !!m && (m.kind !== "subject" || subjectFront) && !disabled;
  const keyed = !!m && hasMaskKeys(m);
  // The published matte refreshes at the segmentation cadence; its stamp is
  // the memo key, so the CSS mask follows the person as the video plays.
  const snap = subjectFront && active ? subjectMatteSnapshot() : null;
  // The repaint keys: a keyed mask ticks at the matte cadence, and the
  // subject branch follows the published matte's stamp.
  const keyTick = keyed ? Math.round(tLocal * MASK_CSS_FPS) : 0;
  const snapTick = subjectFront ? (snap?.at ?? -1) : 0;
  // One canvas per element, reused across repaints.
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const [box, setBox] = useState<{ w: number; h: number } | null>(null);
  useEffect(() => {
    if (!active) return;
    const el = boxRef.current;
    if (!el) return;
    const measure = () => setBox({ w: el.offsetWidth, h: el.offsetHeight });
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, [active, boxRef]);
  return useMemo(() => {
    if (!active || !m || !box || box.w < 1 || box.h < 1) return undefined;
    const canvas = (canvasRef.current ??= document.createElement("canvas"));
    if (subjectFront) {
      // Trim to the person: the published matte becomes the element's
      // mask-image, positioned so it stays anchored to the frame while the
      // element sits inside it. A computed matte with no person is empty
      // coverage (the element hides, like every renderer); before the first
      // matte lands the element stays whole.
      if (!snap) return undefined;
      if (!snap.canvas) {
        return {
          maskImage: NO_COVERAGE_MASK,
          WebkitMaskImage: NO_COVERAGE_MASK,
        };
      }
      if (canvas.width !== snap.canvas.width) canvas.width = snap.canvas.width;
      if (canvas.height !== snap.canvas.height) canvas.height = snap.canvas.height;
      const ctx = canvas.getContext("2d");
      if (!ctx) return undefined;
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.globalCompositeOperation = "source-over";
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      const featherMatte =
        (m.feather ?? 0) * scale * (snap.canvas.width / Math.max(1, stageWidth));
      if (featherMatte > 0 && "filter" in ctx) ctx.filter = `blur(${featherMatte / 2}px)`;
      ctx.drawImage(snap.canvas, 0, 0);
      ctx.filter = "none";
      const url = canvas.toDataURL();
      const boxLeft = o.x * stageWidth - box.w / 2;
      const boxTop = o.y * stageHeight - box.h / 2;
      return {
        maskImage: `url(${url})`,
        WebkitMaskImage: `url(${url})`,
        maskRepeat: "no-repeat",
        WebkitMaskRepeat: "no-repeat",
        maskSize: `${stageWidth}px ${stageHeight}px`,
        WebkitMaskSize: `${stageWidth}px ${stageHeight}px`,
        maskPosition: `${-boxLeft}px ${-boxTop}px`,
        WebkitMaskPosition: `${-boxLeft}px ${-boxTop}px`,
      };
    }
    // The canvas caps below the box size and the CSS mask stretches it back:
    // the soft coverage survives the scale and the PNG encode stays small.
    const s = Math.min(1, MASK_CSS_MAX / Math.max(box.w, box.h));
    const cw = Math.max(1, Math.round(box.w * s));
    const ch = Math.max(1, Math.round(box.h * s));
    if (canvas.width !== cw) canvas.width = cw;
    if (canvas.height !== ch) canvas.height = ch;
    const ctx = canvas.getContext("2d");
    if (!ctx) return undefined;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.globalCompositeOperation = "source-over";
    ctx.clearRect(0, 0, cw, ch);
    if (m.invert) {
      // Keep-outside: full coverage with the shape cut out of it, because a
      // CSS mask has no invert of its own.
      ctx.fillStyle = "#ffffff";
      ctx.fillRect(0, 0, cw, ch);
      ctx.globalCompositeOperation = "destination-out";
    }
    // Map frame coordinates onto the box: the element's anchor sits at the
    // box center, which is where the painter anchors the mask.
    ctx.scale(s, s);
    ctx.translate(box.w / 2 - o.x * stageWidth, box.h / 2 - o.y * stageHeight);
    paintMaskCoverage(
      ctx,
      { ...m, invert: undefined },
      tLocal,
      { width: stageWidth, height: stageHeight, scale },
      { x: o.x, y: o.y }
    );
    const url = canvas.toDataURL();
    return {
      maskImage: `url(${url})`,
      WebkitMaskImage: `url(${url})`,
      maskRepeat: "no-repeat",
      WebkitMaskRepeat: "no-repeat",
      maskSize: "100% 100%",
      WebkitMaskSize: "100% 100%",
    };
    // The keyed tick folds a 15fps-quantized tLocal in only when the mask
    // actually animates; the matte stamp refreshes the subject branch.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active, m, box, o.x, o.y, stageWidth, stageHeight, scale, keyTick, snapTick]);
}

/** Handle styling shared by the mask gizmo's grips: amber, so mask handles
 * never read as the element's own blue chrome. */
const MASK_GRIP =
  "absolute z-10 rounded-full border-[2.5px] border-[#ff9f0a] bg-white shadow-[0_1px_4px_rgba(0,0,0,0.4)]";

/**
 * On-canvas mask editing: a center grip that moves the mask and a corner grip
 * that resizes it (the band height, for mirror). The grips are children of
 * the element box, so they ride its transform; screen deltas are folded back
 * through the element's live rotation and scale, then through the mask's own
 * angle for the resize. With mask keys in play a drag writes the key at the
 * playhead, the same contract as dragging a keyframed element.
 */
function MaskGizmo({
  overlay: o,
  stageWidth,
  stageHeight,
  tLocal,
  rotation,
  poseScale,
}: {
  overlay: Overlay;
  stageWidth: number;
  stageHeight: number;
  tLocal: number;
  rotation: number;
  poseScale: number;
}) {
  const m = o.mask!;
  const f = maskFrameAt(m, tLocal);
  const st = () => useEditor.getState();
  const writeGeom = (patch: Partial<Omit<MaskKey, "t">>) => {
    const cur = st().overlays.find((x) => x.id === o.id)?.mask;
    if (!cur) return;
    if (hasMaskKeys(cur)) return st().setOverlayMaskKey(o.id, tLocal, patch, { transient: true });
    st().updateOverlayTransient(o.id, { mask: { ...cur, ...patch } });
  };
  // Screen deltas → the box's local space (undo the element transform).
  const toLocal = (dx: number, dy: number) => {
    const r = (-rotation * Math.PI) / 180;
    const s = poseScale || 1;
    return {
      x: (dx * Math.cos(r) - dy * Math.sin(r)) / s,
      y: (dx * Math.sin(r) + dy * Math.cos(r)) / s,
    };
  };
  const theta = (f.rotation * Math.PI) / 180;
  const sizable = m.kind === "rect" || m.kind === "circle" || m.kind === "mirror";
  // The resize grip sits on the mask's corner (mirror: its lower edge),
  // turned by the mask's own angle.
  const gx = m.kind === "mirror" ? 0 : (f.w * stageWidth) / 2;
  const gy = (f.h * stageHeight) / 2;
  const rx = gx * Math.cos(theta) - gy * Math.sin(theta);
  const ry = gx * Math.sin(theta) + gy * Math.cos(theta);
  const clampSize = (v: number) => Math.min(2, Math.max(0.01, v));
  return (
    <>
      <span
        title="Drag to move the mask"
        className={cn(MASK_GRIP, "size-[13px] cursor-move")}
        style={{
          left: `calc(50% + ${f.x * stageWidth}px)`,
          top: `calc(50% + ${f.y * stageHeight}px)`,
          transform: "translate(-50%, -50%)",
        }}
        onPointerDown={(e) => {
          e.stopPropagation();
          st().pushHistory();
          const g0 = f;
          startDrag(e, {
            onMove: (dx, dy) => {
              const l = toLocal(dx, dy);
              writeGeom({ x: g0.x + l.x / stageWidth, y: g0.y + l.y / stageHeight });
            },
          });
        }}
      />
      {sizable && (
        <span
          title="Drag to resize the mask"
          className={cn(MASK_GRIP, "size-[11px] cursor-nwse-resize rounded-[3px]")}
          style={{
            left: `calc(50% + ${f.x * stageWidth + rx}px)`,
            top: `calc(50% + ${f.y * stageHeight + ry}px)`,
            transform: "translate(-50%, -50%)",
          }}
          onPointerDown={(e) => {
            e.stopPropagation();
            st().pushHistory();
            const g0 = f;
            startDrag(e, {
              onMove: (dx, dy) => {
                const l = toLocal(dx, dy);
                // Into the mask's own axes for width/height growth.
                const mx = l.x * Math.cos(theta) + l.y * Math.sin(theta);
                const my = -l.x * Math.sin(theta) + l.y * Math.cos(theta);
                writeGeom({
                  ...(m.kind !== "mirror"
                    ? { w: clampSize(g0.w + (2 * mx) / stageWidth) }
                    : {}),
                  h: clampSize(g0.h + (2 * my) / stageHeight),
                });
              },
            });
          }}
        />
      )}
    </>
  );
}

/** A shape drawn as inline SVG with the painter's own pixel geometry
 * (`shapeMetrics` in stage space), so preview and export burn-in match. */
function ShapeView({
  shape: o,
  stageWidth,
  stageHeight,
  scale,
}: {
  shape: ShapeOverlay;
  stageWidth: number;
  stageHeight: number;
  scale: number;
}) {
  const m = shapeMetrics(o, { width: stageWidth, height: stageHeight, scale });
  if (lineLikeShape(o.shape)) {
    const h = Math.max(m.thickness, m.headHalf * 2);
    const mid = h / 2;
    return (
      <svg
        width={m.w}
        height={h}
        className="block overflow-visible"
        style={{ pointerEvents: "none" }}
      >
        <line
          x1={m.thickness / 2}
          y1={mid}
          x2={o.shape === "arrow" ? m.w - m.headLen : m.w - m.thickness / 2}
          y2={mid}
          stroke={o.fill}
          strokeWidth={m.thickness}
          strokeLinecap="round"
        />
        {o.shape === "arrow" && (
          <polygon
            points={`${m.w},${mid} ${m.w - m.headLen},${mid - m.headHalf} ${m.w - m.headLen},${mid + m.headHalf}`}
            fill={o.fill}
          />
        )}
      </svg>
    );
  }
  return (
    <svg width={m.w} height={m.h} className="block overflow-visible" style={{ pointerEvents: "none" }}>
      {o.shape === "rect" ? (
        <rect
          x={0}
          y={0}
          width={m.w}
          height={m.h}
          rx={m.radius}
          fill={o.fill}
          fillOpacity={o.fillOpacity ?? 1}
          stroke={o.stroke?.color}
          strokeWidth={m.strokeWidth || undefined}
        />
      ) : o.shape === "ellipse" ? (
        <ellipse
          cx={m.w / 2}
          cy={m.h / 2}
          rx={m.w / 2}
          ry={m.h / 2}
          fill={o.fill}
          fillOpacity={o.fillOpacity ?? 1}
          stroke={o.stroke?.color}
          strokeWidth={m.strokeWidth || undefined}
        />
      ) : (
        <path
          d={shapePathD(o.shape, m.w, m.h)}
          fill={o.fill}
          fillOpacity={o.fillOpacity ?? 1}
          stroke={o.stroke?.color}
          strokeWidth={m.strokeWidth || undefined}
          strokeLinejoin="round"
        />
      )}
    </svg>
  );
}

/** A sticker: the project image at its stored width (height from the asset's
 * own aspect), or a Lottie animation frame-seeked from timeline time. */
function StickerView({
  sticker: o,
  stageWidth,
  t,
}: {
  sticker: StickerOverlay;
  stageWidth: number;
  t: number;
}) {
  const asset = useEditor((s) =>
    o.assetId ? s.assets.find((a) => a.id === o.assetId) : undefined
  );
  if (!asset) return <span className="block size-8 rounded bg-white/20" />;
  if (o.lottie) {
    return <LottieView asset={asset} width={o.w * stageWidth} tLocal={Math.max(0, t - o.start)} />;
  }
  return (
    // eslint-disable-next-line @next/next/no-img-element -- project media blob/engine URL
    <img
      src={asset.url}
      alt={asset.name}
      draggable={false}
      className="block max-w-none select-none"
      style={{ width: o.w * stageWidth, height: "auto" }}
    />
  );
}

/** A Lottie sticker in the preview: its own player instance, hard-seeked to
 * the timeline moment (goToAndStop — never free-running), destroyed on
 * unmount. Out-of-range elements don't mount, which caps live instances. */
function LottieView({
  asset,
  width,
  tLocal,
}: {
  asset: { id: string; url: string; fileName: string; name: string };
  width: number;
  tLocal: number;
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const handleRef = useRef<LottieHandle | null>(null);
  const [ready, setReady] = useState(0);
  const [aspect, setAspect] = useState(1);

  useEffect(() => {
    let live = true;
    void import("@/cut/lib/lottieAssets").then(async (m) => {
      const full = useEditor.getState().assets.find((a) => a.id === asset.id);
      const handle = full ? await m.newLottieInstance(full) : null;
      if (!live) {
        handle?.destroy();
        return;
      }
      handleRef.current = handle;
      if (handle) setAspect(handle.width / Math.max(1, handle.height));
      setReady((n) => n + 1);
    });
    return () => {
      live = false;
      handleRef.current?.destroy();
      handleRef.current = null;
    };
  }, [asset.id]);

  useEffect(() => {
    const handle = handleRef.current;
    const canvas = canvasRef.current;
    if (!handle || !canvas) return;
    const frame = handle.seek(tLocal);
    if (canvas.width !== frame.width || canvas.height !== frame.height) {
      canvas.width = frame.width;
      canvas.height = frame.height;
    }
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.drawImage(frame, 0, 0);
  }, [tLocal, ready]);

  return (
    <canvas
      ref={canvasRef}
      className="block max-w-none select-none"
      style={{ width, height: width / aspect }}
    />
  );
}
