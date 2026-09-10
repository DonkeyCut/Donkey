"use client";

import { Menu as MenuPrimitive } from "@base-ui/react/menu";
import { ChevronDown, Minus, Plus, RotateCcw, X } from "lucide-react";
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import {
  flatSpeedCurve,
  retimeOf,
  SPEED_CURVE_MAX,
  SPEED_CURVE_MIN,
  SPEED_CURVE_PRESETS,
  speedCurveOf,
  speedCurvePresetOf,
  type Retime,
  type SpeedNode,
} from "@donkeycut/effects-kit";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Button } from "@/components/ui/button";
import { PICKED_RING } from "@/cut/lib/assetPick";
import { startDrag } from "@/cut/lib/drag";
import { playheadAt, setSkim, skimAt, subscribePlayhead } from "@/cut/lib/playhead";
import { useSpeedCurveUi } from "@/cut/lib/speedCurveUi";
import { useEditor } from "@/cut/lib/store";
import type { VideoClip } from "@/cut/lib/types";
import { cn } from "@/lib/utils";

/**
 * The speed curve editor: a strip floating over the timeline's top edge, the
 * full width of the editor, over whatever sits above it. It draws one
 * clip's rate across its footage. Left to right is the clip's trimmed source;
 * up and down is the rate on a log scale, 1× through the middle. Nodes are
 * the curve's control points: drag one to move it, click the line to add one
 * where it was clicked, double-click a node to take it away. A click off the
 * line moves the playhead there, and hovering the graph skims the preview,
 * so the moment under the pointer is on screen before a node is placed.
 * Touching the line or a node leaves the playhead where it is.
 *
 * Edits draft locally and commit on release through the store's one curve
 * setter, so every gesture is one undo step and every surface reads the
 * same map.
 */

const GRAPH_H = 116;
const PAD_X = 14;
const PAD_Y = 10;
/** Pixels within which a drag lands on a beat or the 1× line. */
const SNAP_PX = 6;
/** Pixels within which a press counts as a press on the line. */
const LINE_HIT_PX = 8;
/** Closest two nodes may sit, source seconds. */
const MIN_GAP = 1 / 60;
const FRAME = 1 / 30;
/** The grid: the ends carry a label, 1× is the solid line through the
 * middle, and the lines halfway between, on the log scale, are dashed. */
const RATE_LINES = [10, Math.sqrt(10), 1, 1 / Math.sqrt(10), 0.1];
const LABELED = new Set([10, 0.1]);

const LOG_MIN = Math.log10(SPEED_CURVE_MIN);
const LOG_MAX = Math.log10(SPEED_CURVE_MAX);

const clampRate = (r: number) => Math.min(SPEED_CURVE_MAX, Math.max(SPEED_CURVE_MIN, r));
/** A rate as people say it: 2×, 0.5×, 0.25×. */
const fmtRate = (r: number) => `${+r.toFixed(2)}×`;
const fmtSec = (s: number) => `${s.toFixed(1)}s`;

export function SpeedCurveStrip() {
  // The strip shows for the selected clip when that clip's curve is open.
  // Every clip keeps its own state, so a selection elsewhere hides the strip
  // and a return to the clip brings it back.
  const selectedId = useEditor((s) => (s.selection?.kind === "clip" ? s.selection.id : null));
  const clipId = useSpeedCurveUi((s) => (selectedId && s.open.has(selectedId) ? selectedId : null));
  const clip = useEditor((s) => (clipId ? s.clips.find((c) => c.id === clipId) : undefined));
  // Clips that are gone drop their entry.
  const clipIds = useEditor((s) => s.clips);
  useEffect(() => {
    const ui = useSpeedCurveUi.getState();
    for (const id of ui.open) if (!clipIds.some((c) => c.id === id)) ui.close(id);
  }, [clipIds]);
  if (!clip) return null;
  return <Strip key={clip.id} clip={clip} />;
}

function Strip({ clip }: { clip: VideoClip }) {
  const asset = useEditor((s) => s.assets.find((a) => a.id === clip.assetId));
  const picked = useEditor((s) =>
    s.selectedKey?.track === "speed" && s.selectedKey.id === clip.id ? s.selectedKey.t : null
  );
  const [draft, setDraft] = useState<SpeedNode[] | null>(null);
  // The axis a drag started on. Width is timeline time, so editing the curve
  // moves the ground under the cursor; holding the axis for the length of a
  // drag keeps the node under the pointer and the tiles still.
  const [heldAxis, setHeldAxis] = useState<Retime | null>(null);
  const nodes = useMemo(
    () => draft ?? speedCurveOf(clip) ?? flatSpeedCurve(clip),
    [draft, clip]
  );
  const rt = useMemo(
    () => retimeOf({ in: clip.in, out: clip.out, speedCurve: nodes, reverse: clip.reverse }),
    [clip.in, clip.out, nodes, clip.reverse]
  );

  const boxRef = useRef<HTMLDivElement | null>(null);
  const [width, setWidth] = useState(0);
  useLayoutEffect(() => {
    const box = boxRef.current;
    if (!box) return;
    const ro = new ResizeObserver(([e]) => setWidth(e.contentRect.width));
    ro.observe(box);
    setWidth(box.clientWidth);
    return () => ro.disconnect();
  }, []);

  const innerW = Math.max(1, width - PAD_X * 2);
  const innerH = GRAPH_H - PAD_Y * 2;
  // Left to right is the clip as it plays, the same axis the timeline bar
  // uses, so a node sits over the picture the bar shows at that moment.
  const axis = heldAxis ?? rt;
  const axisLen = Math.max(1e-3, axis.len);
  const xOf = (src: number) => PAD_X + (axis.tAt(src) / axisLen) * innerW;
  const srcOf = (x: number) =>
    axis.srcAt(Math.max(0, Math.min(axisLen, ((x - PAD_X) / innerW) * axisLen)));
  const yOf = (rate: number) =>
    PAD_Y + (1 - (Math.log10(clampRate(rate)) - LOG_MIN) / (LOG_MAX - LOG_MIN)) * innerH;
  const rateOf = (y: number) =>
    clampRate(Math.pow(10, LOG_MIN + (1 - (y - PAD_Y) / innerH) * (LOG_MAX - LOG_MIN)));

  const beats = useMemo(
    () => (asset?.beats?.beats ?? []).filter((b) => b >= clip.in && b <= clip.out),
    [asset?.beats, clip.in, clip.out]
  );

  const curvePath = useMemo(() => {
    if (innerW <= 1) return "";
    const steps = Math.max(2, Math.min(400, Math.round(innerW / 2)));
    const pts: string[] = [];
    for (let i = 0; i <= steps; i++) {
      const x = PAD_X + (i / steps) * innerW;
      pts.push(`${x.toFixed(1)},${yOf(rt.rateAtSrc(srcOf(x))).toFixed(1)}`);
    }
    return `M${pts.join("L")}`;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rt, axis, innerW, innerH]);

  // The playhead and the skimmer, mapped through the clip's map onto the
  // graph's axis. One DOM write per line per move.
  const playheadRef = useRef<HTMLDivElement | null>(null);
  const skimRef = useRef<HTMLDivElement | null>(null);
  const geom = useRef({ xOf, rt, start: clip.start, len: rt.len });
  const paintLine = (el: HTMLDivElement | null, t: number | null) => {
    if (!el) return;
    const g = geom.current;
    const tLocal = t === null ? -1 : t - g.start;
    if (tLocal < -1e-6 || tLocal > g.len + 1e-6) {
      el.style.opacity = "0";
      return;
    }
    el.style.opacity = "1";
    el.style.left = `${g.xOf(g.rt.srcAt(tLocal))}px`;
  };
  const paintLines = () => {
    paintLine(playheadRef.current, playheadAt());
    paintLine(skimRef.current, skimAt());
  };
  // The map and the geometry change with every draft and resize; the lines
  // read the newest through the ref and repaint after each render.
  useEffect(() => {
    geom.current = { xOf, rt, start: clip.start, len: rt.len };
    paintLines();
  });
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => subscribePlayhead(paintLines), []);
  // The skimmer belongs to the pointer over the graph; the strip closing
  // leaves it off.
  useEffect(() => () => setSkim(null), []);

  const pick = (src: number | null) => {
    useEditor.setState({
      selectedKey: src === null ? null : { kind: "clip", id: clip.id, t: src, track: "speed" },
    });
  };
  const commit = (next: SpeedNode[]) => {
    setDraft(null);
    useEditor.getState().setClipSpeedCurve(clip.id, next);
  };

  /** Where a node may sit between its neighbours. */
  const bounds = (list: SpeedNode[], i: number) => ({
    lo: i > 0 ? list[i - 1][0] + MIN_GAP : clip.in,
    hi: i < list.length - 1 ? list[i + 1][0] - MIN_GAP : clip.out,
  });

  const insertAt = (src: number, rate: number, list: SpeedNode[]): SpeedNode[] => {
    const next: SpeedNode[] = [...list, [src, clampRate(rate)]];
    next.sort((a, b) => a[0] - b[0]);
    return next;
  };

  const addAtPlayhead = () => {
    const tLocal = Math.max(0, Math.min(rt.len, playheadAt() - clip.start));
    const src = Math.min(clip.out, Math.max(clip.in, rt.srcAt(tLocal)));
    if (nodes.some((n) => Math.abs(n[0] - src) < MIN_GAP)) return;
    const next = insertAt(src, rt.rateAtSrc(src), nodes);
    pick(src);
    commit(next);
  };

  const removePicked = () => {
    if (picked === null || nodes.length <= 1) return;
    const next = nodes.filter((n) => Math.abs(n[0] - picked) > 1e-6);
    if (next.length === nodes.length) return;
    pick(null);
    commit(next);
  };

  const nudge = (dSrc: number, rateScale: number) => {
    if (picked === null) return;
    const i = nodes.findIndex((n) => Math.abs(n[0] - picked) < 1e-6);
    if (i < 0) return;
    const { lo, hi } = bounds(nodes, i);
    const src = Math.min(hi, Math.max(lo, nodes[i][0] + dSrc));
    const rate = clampRate(nodes[i][1] * rateScale);
    const next = nodes.map((n, j) => (j === i ? ([src, rate] as SpeedNode) : n));
    pick(src);
    commit(next);
  };

  const srcAtX = (x: number) => Math.min(clip.out, Math.max(clip.in, srcOf(x)));
  /** Whether a graph point sits on the drawn line. A steep segment is nearly
   * vertical, so the line is sampled across the hit width, and the press
   * counts when any sample is within reach. */
  const onLine = (x: number, y: number) => {
    for (let dx = -LINE_HIT_PX; dx <= LINE_HIT_PX; dx += 2) {
      const sx = x + dx;
      if (sx < PAD_X || sx > PAD_X + innerW) continue;
      if (Math.abs(yOf(rt.rateAtSrc(srcAtX(sx))) - y) <= LINE_HIT_PX) return true;
    }
    return false;
  };
  const graphPoint = (e: { clientX: number; clientY: number; currentTarget: Element }) => {
    const rect = e.currentTarget.getBoundingClientRect();
    return { x: e.clientX - rect.left, y: e.clientY - rect.top };
  };

  // A press on the line adds a node there; a press anywhere else in the
  // strip moves the playhead, and dragging from there scrubs.
  const scrubFrom = (e: React.PointerEvent, x: number) => {
    pick(null);
    setSkim(null);
    const seekAt = (px: number) => useEditor.getState().seek(clip.start + rt.tAt(srcAtX(px)));
    seekAt(x);
    startDrag(e, { onMove: (dx) => seekAt(x + dx) });
  };
  const onGraphPointerDown = (e: React.PointerEvent<SVGSVGElement>) => {
    if (e.button !== 0) return;
    const { x, y } = graphPoint(e);
    // The line beside a node belongs to the node's handle, so a press there
    // scrubs like any other.
    if (onLine(x, y) && !nodes.some((n) => Math.abs(xOf(n[0]) - x) < SNAP_PX * 2)) {
      const src = srcAtX(x);
      const next = insertAt(src, rt.rateAtSrc(src), nodes);
      pick(src);
      commit(next);
      return;
    }
    scrubFrom(e, x);
  };
  const onHeaderPointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    if (e.button !== 0 || (e.target as Element).closest("button")) return;
    scrubFrom(e, e.clientX - e.currentTarget.getBoundingClientRect().left);
  };

  // Hovering skims the preview to the moment under the pointer, the way the
  // timeline does; a held button or a running cut leaves the picture to the
  // playhead. The cursor says what a press would do.
  const onGraphPointerMove = (e: React.PointerEvent<SVGSVGElement>) => {
    const { x, y } = graphPoint(e);
    e.currentTarget.style.cursor = onLine(x, y) ? "crosshair" : "default";
    if (e.buttons || useEditor.getState().playing) return setSkim(null);
    setSkim(clip.start + rt.tAt(srcAtX(x)));
  };
  const onGraphPointerLeave = () => setSkim(null);

  const onCapPointerDown = (e: React.PointerEvent) => {
    const box = boxRef.current;
    if (!box) return;
    const left = box.getBoundingClientRect().left;
    const x0 = e.clientX - left;
    setSkim(null);
    startDrag(e, {
      cursor: () => "ew-resize",
      onMove: (dx) => useEditor.getState().seek(clip.start + rt.tAt(srcAtX(x0 + dx))),
    });
  };

  const onNodePointerDown = (e: React.PointerEvent, i: number) => {
    const node = nodes[i];
    pick(node[0]);
    setHeldAxis(axis);
    const x0 = xOf(node[0]);
    const y0 = yOf(node[1]);
    const { lo, hi } = bounds(nodes, i);
    let live: SpeedNode[] = nodes;
    startDrag(e, {
      cursor: () => "grabbing",
      onMove: (dx, dy, ev) => {
        let x = x0 + dx;
        let y = y0 + dy;
        if (!ev.altKey) {
          const beat = beats.find((b) => Math.abs(xOf(b) - x) <= SNAP_PX);
          if (beat !== undefined) x = xOf(beat);
          if (Math.abs(yOf(1) - y) <= SNAP_PX) y = yOf(1);
        }
        const src = Math.min(hi, Math.max(lo, srcOf(x)));
        const rate = rateOf(Math.min(GRAPH_H - PAD_Y, Math.max(PAD_Y, y)));
        live = nodes.map((n, j) => (j === i ? ([src, rate] as SpeedNode) : n));
        setDraft(live);
        pick(src);
      },
      onUp: (_dx, _dy, moved) => {
        setHeldAxis(null);
        if (moved) commit(live);
      },
    });
  };

  const onKeyDown = (e: React.KeyboardEvent) => {
    const big = e.shiftKey;
    switch (e.key) {
      case "ArrowLeft":
        nudge(-(big ? FRAME * 10 : FRAME), 1);
        break;
      case "ArrowRight":
        nudge(big ? FRAME * 10 : FRAME, 1);
        break;
      case "ArrowUp":
        nudge(0, big ? 1.25 : 1.05);
        break;
      case "ArrowDown":
        nudge(0, 1 / (big ? 1.25 : 1.05));
        break;
      case "Delete":
      case "Backspace":
        removePicked();
        break;
      case "Escape":
        useSpeedCurveUi.getState().close(clip.id);
        break;
      default:
        return;
    }
    e.preventDefault();
    e.stopPropagation();
  };

  const pickedRate = picked === null ? null : nodes.find((n) => Math.abs(n[0] - picked) < 1e-6)?.[1];

  // The picker names the preset the curve is; a curve that is none of them
  // is "Custom", drawn as itself through the span.
  const presetId = speedCurvePresetOf(nodes, clip.in, clip.out);
  const preset = SPEED_CURVE_PRESETS.find((p) => p.id === presetId);
  const span = Math.max(1e-6, clip.out - clip.in);
  const shape = useMemo<SpeedNode[]>(
    () => preset?.shape ?? nodes.map(([at, r]): SpeedNode => [(at - clip.in) / span, r]),
    [preset, nodes, clip.in, span]
  );

  return (
    <div
      className="absolute inset-x-0 bottom-full z-40 flex min-w-0 flex-col border-t border-border bg-muted shadow-[0_-6px_16px_rgba(0,0,0,0.08)] outline-none"
      tabIndex={0}
      onKeyDown={onKeyDown}
      data-testid="speed-curve-strip"
    >
      <div
        className="flex h-10 items-center gap-1.5 px-2 pt-2 text-[11px]"
        onPointerDown={onHeaderPointerDown}
      >
        {pickedRate != null && (
          <span className="tabular-nums text-foreground/70">
            node {fmtRate(pickedRate)} at {fmtSec(rt.tAt(picked!))}
          </span>
        )}
        <span className="flex-1" />
        <DropdownMenu>
          <DropdownMenuTrigger
            render={
              <Button
                variant="outline"
                size="xs"
                title={preset?.hint ?? "Pick a preset curve"}
                className="gap-1.5 pl-1.5 font-normal"
              />
            }
          >
            <Sparkline shape={shape} />
            <span>{preset?.label ?? "Custom"}</span>
            <ChevronDown className="size-3 text-muted-foreground" />
          </DropdownMenuTrigger>
          <DropdownMenuContent side="top" align="center" sideOffset={8} className="overflow-visible p-0">
            {/* The pad is the picked tile's ring and its offset, drawn outside
                the tile. */}
            <div className="grid grid-cols-2 gap-2 p-2">
              {SPEED_CURVE_PRESETS.map((p) => (
                <DropdownMenuItem
                  key={p.id}
                  title={p.hint}
                  className={cn(
                    "relative block h-20 w-40 overflow-hidden rounded-xl border border-border bg-muted/40 p-0 focus:bg-muted",
                    p.id === presetId && PICKED_RING
                  )}
                  onClick={() => {
                    pick(null);
                    setDraft(null);
                    useEditor.getState().setClipSpeedPreset(clip.id, p.id);
                  }}
                >
                  <span className="absolute inset-x-2.5 top-2.5">
                    <Sparkline shape={p.shape} w={140} h={48} grid />
                  </span>
                  <span className="absolute bottom-1.5 left-2.5 text-[11.5px] font-medium">{p.label}</span>
                </DropdownMenuItem>
              ))}
            </div>
            <MenuPrimitive.Arrow className="absolute -bottom-2 left-1/2 -translate-x-1/2">
              <svg width="20" height="10" viewBox="0 0 20 10" className="block">
                <path d="M0 0 L10 10 L20 0" className="fill-popover" />
                <path d="M0 0 L10 10 L20 0" fill="none" className="stroke-foreground/10" />
              </svg>
            </MenuPrimitive.Arrow>
          </DropdownMenuContent>
        </DropdownMenu>
        <span className="mx-1 h-4 w-px bg-border" />
        <IconButton title="Add a node at the playhead" onClick={addAtPlayhead}>
          <Plus className="size-3.5" />
        </IconButton>
        <IconButton
          title="Remove the picked node (Delete)"
          disabled={picked === null || nodes.length <= 1}
          onClick={removePicked}
        >
          <Minus className="size-3.5" />
        </IconButton>
        <IconButton
          title="Flatten to 1×"
          onClick={() => {
            pick(null);
            setDraft(null);
            // Back to a plain clip at 1×: the curve goes with the rate, so the
            // timeline's rail and badge go with it.
            useEditor.getState().setClipSpeed(clip.id, 1);
          }}
        >
          <RotateCcw className="size-3.5" />
        </IconButton>
        <IconButton title="Close (Esc)" onClick={() => useSpeedCurveUi.getState().close(clip.id)}>
          <X className="size-3.5" />
        </IconButton>
      </div>
      <div ref={boxRef} className="relative select-none overflow-hidden" style={{ height: GRAPH_H }}>
        <svg
          className="absolute inset-0 h-full w-full"
          onPointerDown={onGraphPointerDown}
          onPointerMove={onGraphPointerMove}
          onPointerLeave={onGraphPointerLeave}
        >
          {RATE_LINES.map((r) => (
            <g key={r}>
              <line
                x1={PAD_X}
                x2={PAD_X + innerW}
                y1={yOf(r)}
                y2={yOf(r)}
                stroke="currentColor"
                strokeOpacity={r === 1 ? 0.45 : 0.18}
                strokeDasharray={r === 1 ? undefined : "2 3"}
              />
              {LABELED.has(r) && (
                <text x={PAD_X + 3} y={yOf(r) - 2} fontSize={9} fill="currentColor" fillOpacity={0.85}>
                  {fmtRate(r)}
                </text>
              )}
            </g>
          ))}
          {beats.map((b) => (
            <line
              key={b}
              x1={xOf(b)}
              x2={xOf(b)}
              y1={PAD_Y}
              y2={GRAPH_H - PAD_Y}
              stroke="#ff9f0a"
              strokeOpacity={0.5}
            />
          ))}
          <path d={curvePath} fill="none" stroke="#0a84ff" strokeWidth={2} />
          {nodes.map((n, i) => {
            const isPicked = picked !== null && Math.abs(n[0] - picked) < 1e-6;
            return (
              <circle
                key={i}
                cx={xOf(n[0])}
                cy={yOf(n[1])}
                r={isPicked ? 6 : 5}
                fill="white"
                stroke={isPicked ? "#0a84ff" : "rgba(0,0,0,0.5)"}
                strokeWidth={isPicked ? 2 : 1}
                className="cursor-grab"
                onPointerDown={(e) => {
                  e.stopPropagation();
                  onNodePointerDown(e, i);
                }}
                onDoubleClick={(e) => {
                  e.stopPropagation();
                  if (nodes.length <= 1) return;
                  pick(null);
                  commit(nodes.filter((_, j) => j !== i));
                }}
              />
            );
          })}
        </svg>
        <div
          ref={skimRef}
          className="pointer-events-none absolute top-0 h-full w-px bg-foreground/30"
          style={{ opacity: 0 }}
        />
        <div
          ref={playheadRef}
          className="pointer-events-none absolute top-0 h-full w-[1.5px] bg-[#0a84ff] shadow-[0_0_8px_rgba(10,132,255,0.6)]"
          style={{ opacity: 0 }}
        >
          {/* The timeline playhead's grab cap: drag it to scrub. */}
          <div
            className="pointer-events-auto absolute top-0 left-[-4.5px] h-3 w-2.5 cursor-ew-resize rounded-t-[3px] bg-[#0a84ff] [clip-path:polygon(0_0,100%_0,100%_58%,50%_100%,0_58%)]"
            onPointerDown={onCapPointerDown}
          />
        </div>
      </div>
    </div>
  );
}

/** A curve at a glance: the 1× line and the rate through the span, on the
 * same log scale as the graph, drawn by the same evaluator. */
function Sparkline({
  shape,
  w = 32,
  h = 16,
  grid,
}: {
  shape: SpeedNode[];
  w?: number;
  h?: number;
  /** Draw the graph's dashed ends around the 1× line, for a tile. */
  grid?: boolean;
}) {
  const pad = 2;
  const yOf = (rate: number) =>
    pad + (1 - (Math.log10(clampRate(rate)) - LOG_MIN) / (LOG_MAX - LOG_MIN)) * (h - pad * 2);
  const d = useMemo(() => {
    const rt = retimeOf({ in: 0, out: 1, speedCurve: shape });
    const steps = Math.max(32, Math.round(w / 2));
    const pts: string[] = [];
    for (let i = 0; i <= steps; i++) {
      const x = 1 + (i / steps) * (w - 2);
      pts.push(`${x.toFixed(1)},${yOf(rt.rateAtSrc(i / steps)).toFixed(1)}`);
    }
    return `M${pts.join("L")}`;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [shape, w, h]);
  return (
    // Sized inline: a menu item squares every svg inside it to an icon, and
    // an inline size outranks that rule.
    <svg
      viewBox={`0 0 ${w} ${h}`}
      style={{ width: w, height: h }}
      className="shrink-0 overflow-visible"
      aria-hidden
    >
      {grid &&
        [SPEED_CURVE_MAX, SPEED_CURVE_MIN].map((r) => (
          <line
            key={r}
            x1={0}
            x2={w}
            y1={yOf(r)}
            y2={yOf(r)}
            stroke="currentColor"
            strokeOpacity={0.2}
            strokeDasharray="2 3"
          />
        ))}
      <line x1={0} x2={w} y1={yOf(1)} y2={yOf(1)} stroke="currentColor" strokeOpacity={0.3} />
      <path
        d={d}
        fill="none"
        stroke="#0a84ff"
        strokeWidth={grid ? 2 : 1.5}
        strokeLinejoin="round"
        strokeLinecap="round"
      />
    </svg>
  );
}

function IconButton({
  title,
  disabled,
  onClick,
  children,
}: {
  title: string;
  disabled?: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      title={title}
      disabled={disabled}
      onClick={onClick}
      className={cn(
        "grid size-6 place-items-center rounded text-foreground hover:bg-accent",
        disabled && "pointer-events-none opacity-40"
      )}
    >
      {children}
    </button>
  );
}
