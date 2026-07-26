"use client";

import { useCallback, useEffect, useRef, useState, type CSSProperties } from "react";
import { startDrag } from "@/cut/lib/drag";
import { useEditor } from "@/cut/lib/store";
import {
  captionStyle,
  cueAt,
  cueOverlay,
  cueWordWindows,
  karaokeLook,
  laneCues,
  subtitleLaneCount,
  trackPos,
} from "@/cut/lib/subtitles";
import {
  LINE_HEIGHT,
  PLATE_PAD_X,
  PLATE_PAD_Y,
  PLATE_RADIUS,
  plateFill,
  SHADOW,
} from "@/cut/lib/textRender";
import { frameOf, fontStack, type TextOverlay } from "@/cut/lib/types";
import { cn } from "@/lib/utils";

// Plate geometry as CSS, kept in lockstep with the export burn-in metrics.
const PLATE_PADDING = `${PLATE_PAD_Y}em ${PLATE_PAD_X}em`;
const PLATE_RADIUS_EM = `${PLATE_RADIUS}em`;

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

export function OverlayLayer({ stageWidth }: { stageWidth: number }) {
  const overlays = useEditor((s) => s.overlays);
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

  // Figma-style smart snapping: while dragging an item, pull its left/center/
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
  const sel = selection?.kind === "text" ? overlays.find((o) => o.id === selection.id) : undefined;
  const isolate = !!sel && !scrubbing && !(t >= sel.start && t <= sel.end);

  return (
    <div ref={rootRef} className="pointer-events-none absolute inset-0">
      <SubtitleCaptions
        stageWidth={stageWidth}
        stageHeight={stageHeight}
        registerBox={registerBox}
        snap={snap}
        onSnapEnd={clearGuides}
      />
      {overlays.map((o) => {
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
            selected={selected}
            ghost={!inRange && !selected}
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
      {Array.from({ length: subtitleLaneCount(subtitles) }, (_, lane) => (
        <SubtitleCaption key={lane} lane={lane} {...props} />
      ))}
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
  stageWidth,
  registerBox,
  snap,
  onSnapEnd,
}: {
  overlay: TextOverlay;
  selected: boolean;
  ghost: boolean;
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

  // Publish this title's box so a sibling drag can align to it.
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

  const style: CSSProperties = {
    left: `${o.x * 100}%`,
    top: `${o.y * 100}%`,
    fontSize: o.size * scale,
    fontFamily: fontStack(o.font),
    fontWeight: o.weight,
    lineHeight: LINE_HEIGHT,
    color: o.color,
    textShadow: o.shadow
      ? `0 ${SHADOW.offsetY * scale}px ${SHADOW.blur * scale}px ${SHADOW.color}`
      : undefined,
    background: o.plate ? plateFill(o) : undefined,
    padding: o.plate ? PLATE_PADDING : undefined,
    borderRadius: o.plate ? `${o.plateRadius ?? PLATE_RADIUS}em` : undefined,
    opacity: ghost ? 0.35 : 1,
  };

  const commitText = () => {
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

  return (
    <div
      ref={boxRef}
      className={cn(
        "overlay-item pointer-events-auto absolute -translate-x-1/2 -translate-y-1/2 cursor-grab rounded-xs text-center whitespace-pre active:cursor-grabbing",
        selected && "outline-[1.5px] outline-offset-[3px] outline-[#0a84ff]",
        editing && "cursor-text"
      )}
      style={style}
      onPointerDown={(e) => {
        if (editing) return;
        const s = useEditor.getState();
        s.select({ kind: "text", id: o.id });
        s.pushHistory();
        const { x, y } = o;
        startDrag(e, {
          onMove: (dx, dy, ev) => {
            const p = snap(o.id, x + dx / stageWidth, y + dy / stageHeight, ev);
            s.updateOverlayTransient(o.id, {
              x: Math.min(0.98, Math.max(0.02, p.x)),
              y: Math.min(0.98, Math.max(0.02, p.y)),
            });
          },
          onUp: onSnapEnd,
        });
      }}
      onDoubleClick={() => setEditing(true)}
    >
      {editing ? (
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
        <span>{o.text}</span>
      )}
      {selected && !editing && (
        <span
          title="Drag to resize"
          className="overlay-resize absolute -right-2 -bottom-2 size-[13px] cursor-nwse-resize rounded-full border-[2.5px] border-[#0a84ff] bg-white shadow-[0_1px_4px_rgba(0,0,0,0.4)]"
          onPointerDown={(e) => {
            const s = useEditor.getState();
            s.pushHistory();
            const box = boxRef.current!.getBoundingClientRect();
            const cx = box.left + box.width / 2;
            const cy = box.top + box.height / 2;
            const d0 = Math.max(8, Math.hypot(e.clientX - cx, e.clientY - cy));
            const size0 = o.size;
            startDrag(e, {
              onMove: (_dx, _dy, ev) => {
                const d = Math.hypot(ev.clientX - cx, ev.clientY - cy);
                const size = Math.round(Math.min(320, Math.max(16, (size0 * d) / d0)));
                s.updateOverlayTransient(o.id, { size });
              },
            });
          }}
        />
      )}
    </div>
  );
}
