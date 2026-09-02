"use client";

import { Minus, Plus, RotateCcw, X } from "lucide-react";
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import {
  flatSpeedCurve,
  retimeOf,
  SPEED_CURVE_MAX,
  SPEED_CURVE_MIN,
  SPEED_CURVE_PRESETS,
  speedCurveOf,
  type Retime,
  type SpeedNode,
} from "@donkeycut/effects-kit";
import { startDrag } from "@/cut/lib/drag";
import { planFilmstrip, type FilmTile } from "@/cut/lib/filmstrip";
import { playheadAt, subscribePlayhead } from "@/cut/lib/playhead";
import { useSpeedCurveUi } from "@/cut/lib/speedCurveUi";
import { useEditor } from "@/cut/lib/store";
import type { MediaAsset, VideoClip } from "@/cut/lib/types";
import { cn } from "@/lib/utils";

/**
 * The speed curve editor: a strip docked over the timeline that draws one
 * clip's rate across its footage. Left to right is the clip's trimmed source;
 * up and down is the rate on a log scale, 1× through the middle. Nodes are
 * the curve's control points: drag one to move it, click the graph to add
 * one on the curve, double-click a node to take it away. The picture behind
 * the graph is the footage at 1×, so a node lands on the moment it slows or
 * hurries. Drags scrub the preview to the node, so what plays there is on
 * screen while it is placed.
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
/** Closest two nodes may sit, source seconds. */
const MIN_GAP = 1 / 60;
const FRAME = 1 / 30;
const RATE_LINES = [0.1, 0.25, 0.5, 1, 2, 4, 10];

const LOG_MIN = Math.log10(SPEED_CURVE_MIN);
const LOG_MAX = Math.log10(SPEED_CURVE_MAX);

const clampRate = (r: number) => Math.min(SPEED_CURVE_MAX, Math.max(SPEED_CURVE_MIN, r));
/** A rate as people say it: 2×, 0.5×, 0.25×. */
const fmtRate = (r: number) => `${+r.toFixed(2)}×`;
const fmtSec = (s: number) => `${s.toFixed(1)}s`;

export function SpeedCurveStrip() {
  const clipId = useSpeedCurveUi((s) => s.clipId);
  const clip = useEditor((s) => (clipId ? s.clips.find((c) => c.id === clipId) : undefined));
  const selected = useEditor(
    (s) => !!clipId && s.selection?.kind === "clip" && s.selection.id === clipId
  );
  // The strip follows the clip it opened for: a selection elsewhere, or the
  // clip going away, closes it.
  useEffect(() => {
    if (clipId && (!clip || !selected)) useSpeedCurveUi.getState().close();
  }, [clipId, clip, selected]);
  if (!clip || !selected) return null;
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
  const rt = useMemo(() => retimeOf({ in: clip.in, out: clip.out, speedCurve: nodes }), [clip.in, clip.out, nodes]);

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

  const tiles = useMemo<FilmTile[]>(
    () => (asset && innerW > 1 ? stripTiles(asset, clip, innerW, axis) : []),
    [asset, clip, innerW, axis]
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

  // The playhead, mapped through the clip's map onto the source axis. One DOM
  // write per move.
  const playheadRef = useRef<HTMLDivElement | null>(null);
  const geom = useRef({ xOf, rt, start: clip.start, len: rt.len });
  const paintPlayhead = () => {
    const el = playheadRef.current;
    if (!el) return;
    const g = geom.current;
    const tLocal = playheadAt() - g.start;
    if (tLocal < -1e-6 || tLocal > g.len + 1e-6) {
      el.style.opacity = "0";
      return;
    }
    el.style.opacity = "1";
    el.style.left = `${g.xOf(g.rt.srcAt(tLocal))}px`;
  };
  // The map and the geometry change with every draft and resize; the line
  // reads the newest through the ref and repaints after each render.
  useEffect(() => {
    geom.current = { xOf, rt, start: clip.start, len: rt.len };
    paintPlayhead();
  });
  useEffect(() => subscribePlayhead(paintPlayhead), []);

  const pick = (src: number | null) => {
    useEditor.setState({
      selectedKey: src === null ? null : { kind: "clip", id: clip.id, t: src, track: "speed" },
    });
  };
  const commit = (next: SpeedNode[]) => {
    setDraft(null);
    useEditor.getState().setClipSpeedCurve(clip.id, next);
  };
  const seekToSrc = (src: number, list: SpeedNode[]) => {
    const map = retimeOf({ in: clip.in, out: clip.out, speedCurve: list });
    useEditor.getState().seek(clip.start + map.tAt(src));
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
    seekToSrc(src, next);
  };

  const onGraphPointerDown = (e: React.PointerEvent<SVGSVGElement>) => {
    if (e.button !== 0) return;
    const rect = e.currentTarget.getBoundingClientRect();
    const x = e.clientX - rect.left;
    const src = Math.min(clip.out, Math.max(clip.in, srcOf(x)));
    if (nodes.some((n) => Math.abs(xOf(n[0]) - x) < SNAP_PX * 2)) return;
    const next = insertAt(src, rt.rateAtSrc(src), nodes);
    pick(src);
    commit(next);
    seekToSrc(src, next);
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
        seekToSrc(src, live);
      },
      onUp: (_dx, _dy, moved) => {
        setHeldAxis(null);
        if (moved) commit(live);
        else seekToSrc(node[0], nodes);
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
        useSpeedCurveUi.getState().close();
        break;
      default:
        return;
    }
    e.preventDefault();
    e.stopPropagation();
  };

  const pickedRate = picked === null ? null : nodes.find((n) => Math.abs(n[0] - picked) < 1e-6)?.[1];

  return (
    <div
      className="flex min-w-0 flex-col border-t border-border bg-background outline-none"
      tabIndex={0}
      onKeyDown={onKeyDown}
      data-testid="speed-curve-strip"
    >
      <div className="flex h-8 items-center gap-1.5 px-2 text-[11px]">
        <span className="font-medium">Speed Curve</span>
        {pickedRate != null && (
          <span className="tabular-nums text-foreground/70">
            node {fmtRate(pickedRate)} at {fmtSec(rt.tAt(picked!))}
          </span>
        )}
        <span className="flex-1" />
        {SPEED_CURVE_PRESETS.map((p) => (
          <button
            key={p.id}
            type="button"
            title={p.hint}
            className="rounded px-1.5 py-0.5 text-foreground hover:bg-accent"
            onClick={() => {
              pick(null);
              setDraft(null);
              useEditor.getState().setClipSpeedPreset(clip.id, p.id);
            }}
          >
            {p.label}
          </button>
        ))}
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
            commit(flatSpeedCurve({ in: clip.in, out: clip.out, speed: 1 }));
          }}
        >
          <RotateCcw className="size-3.5" />
        </IconButton>
        <IconButton title="Close (Esc)" onClick={() => useSpeedCurveUi.getState().close()}>
          <X className="size-3.5" />
        </IconButton>
      </div>
      <div ref={boxRef} className="relative select-none overflow-hidden" style={{ height: GRAPH_H }}>
        {/* The footage at 1×, dimmed, so a node sits on its moment. */}
        <div className="pointer-events-none absolute inset-y-0" style={{ left: PAD_X, width: innerW }}>
          {tiles.map((t, i) => (
            // eslint-disable-next-line @next/next/no-img-element
            <img
              key={i}
              src={t.src}
              alt=""
              draggable={false}
              className="absolute top-0 h-full object-cover opacity-30"
              style={{ left: t.left, width: t.width }}
            />
          ))}
        </div>
        <svg
          className="absolute inset-0 h-full w-full cursor-crosshair"
          onPointerDown={onGraphPointerDown}
        >
          {RATE_LINES.map((r) => (
            <g key={r}>
              <line
                x1={PAD_X}
                x2={PAD_X + innerW}
                y1={yOf(r)}
                y2={yOf(r)}
                stroke="currentColor"
                strokeOpacity={r === 1 ? 0.45 : 0.14}
                strokeDasharray={r === 1 ? undefined : "2 3"}
              />
              <text x={PAD_X + 3} y={yOf(r) - 2} fontSize={9} fill="currentColor" fillOpacity={0.85}>
                {fmtRate(r)}
              </text>
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
                className="cursor-move"
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
          ref={playheadRef}
          className="pointer-events-none absolute top-0 h-full w-px bg-red-500"
          style={{ opacity: 0 }}
        />
      </div>
    </div>
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

/** The strip's tiles: the same plan the clip's bar draws, laid across `w`
 * pixels — same map, same tile times, so the two pictures agree. */
function stripTiles(asset: MediaAsset, clip: VideoClip, w: number, retime: Retime): FilmTile[] {
  if (!asset.thumbs?.length || !asset.thumbStep) return [];
  return planFilmstrip({
    thumbs: asset.thumbs,
    thumbStep: asset.thumbStep,
    duration: asset.duration,
    aspect: (asset.width ?? 16) / Math.max(1, asset.height ?? 9),
    filmIn: clip.in,
    w,
    pps: w / Math.max(1e-3, retime.len),
    speed: retime.rate,
    retime,
    tileH: GRAPH_H,
    minTileW: 24,
    cuts: asset.sceneCuts,
  });
}
