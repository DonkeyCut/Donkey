"use client";

import { useEffect, useRef, useState } from "react";
import { X } from "lucide-react";
import {
  evalOverlayAnim,
  glyphStateAt,
  hasGlyphMotion,
  isGlyphAnimStyle,
  isGlyphLoopStyle,
  HOLD_IDS,
  MOTION,
  presetExtent,
  sampleProperties,
  OVERLAY_ANIM_STYLE_IDS,
  OVERLAY_ANIM_STYLE_LABELS,
  OVERLAY_LOOP_STYLE_IDS,
  OVERLAY_LOOP_STYLE_LABELS,
  type OverlayAnimStyle,
  type OverlayLoopStyle,
} from "@donkeycut/effects-kit";
import { Tile } from "@/cut/components/PanelTile";
import { fontStack } from "@/cut/lib/types";

/**
 * The animation picker: a grid of tiles, each playing its style on the style's
 * own name — the grid reads as what every motion does without asking the
 * reader to hunt for it. The names wear one heavy face across every tile, so
 * what changes from tile to tile is the motion. A card outside the picker
 * holds its name still until the pointer reaches it.
 *
 * Playback samples `evalOverlayAnim` — the same function the preview, the
 * in-tab export and the frame sampler use — so a tile can't promise motion the
 * export won't play. A new style draws itself here the moment the evaluator
 * learns it.
 */

/** Rest beat between demo ramps. An exit clears the stage for its whole ramp,
 * and a per-glyph ramp leaves a couple of letters scattered for most of it, so
 * the demo rests for a multiple of the ramp it just played: the tile shows the
 * name it is offering roughly three quarters of the time. */
const DEMO_HOLD = 1.4;
const HOLD_RATIO = 2.6;

const demoCycle = (ramp: number) => ramp + Math.max(DEMO_HOLD, ramp * HOLD_RATIO);

/** How far apart in its cycle each tile starts from the one before it. The
 * golden ratio spreads any run of tiles evenly around the cycle, so the few
 * that are mid-motion at a given moment are scattered through the grid. */
const PHASE_STEP = 0.618;
/** The cycle a loop tile steps against; loops hold the name the whole way
 * round, so this only has to look unsynchronised. */
const LOOP_SPREAD = 1.2;

/** Design px that map to the tile's preview stage. The evaluator works in px at
 * a 1080 short side; a slide travels 120 of them, which has to read inside a
 * stage a few dozen pixels wide. Low enough that a slide clearly leaves. */
const DEMO_REFERENCE_PX = 190;

/** A loop's travel is a fraction of a slide's — a float bobs 12 design px — so
 * it maps against a shorter reference and stays visible at tile size. */
const LOOP_REFERENCE_PX = 64;

/** The share of the tile the widest part of a move is drawn at. Small enough
 * that the name is still inside the card at the far end of the travel. */
const MOVE_REACH = 0.15;

/** A move is mapped against its own reach: the holds run from a breath that
 * never leaves the spot to a fall the depth of the frame, and one fixed
 * mapping either loses the small ones or throws the big ones clean off the
 * tile. Every move then reads at the same amplitude, and what tells them
 * apart in the grid is the shape of the motion. */
const moveReferencePx = (style: string) => {
  const preset = MOTION.holds[style];
  const travel = preset ? presetExtent(preset).travel : 0;
  return Math.max(LOOP_REFERENCE_PX, travel / MOVE_REACH);
};

const referencePx = (slot: Slot, style: string) =>
  slot === "move"
    ? moveReferencePx(style)
    : slot === "loop"
      ? LOOP_REFERENCE_PX
      : DEMO_REFERENCE_PX;

type Slot = "in" | "out" | "loop" | "move";

/** A move runs the element's whole span, so the tile gives it one of its own
 * to play in — long enough to read a push, short enough to come round again. */
const MOVE_DEMO_SECONDS = 2.4;

const labelOf = (slot: Slot, style: string) =>
  slot === "move"
    ? (MOTION.holds[style]?.label ?? style)
    : slot === "loop"
      ? (OVERLAY_LOOP_STYLE_LABELS[style as OverlayLoopStyle] ?? style)
      : (OVERLAY_ANIM_STYLE_LABELS[style as OverlayAnimStyle] ?? style);

function demoStateAt(
  slot: Slot,
  style: string,
  t: number,
  isText: boolean,
  ramp: number,
  speed: number
) {
  if (slot === "move") {
    // A move is a pose track, not a preset slot: sample it straight and hand
    // back the same shape the ramps produce, so the tile draws it the same way.
    const preset = MOTION.holds[style];
    if (!preset) return { dx: 0, dy: 0, scale: 1, rotate: 0, alpha: 1 };
    const pose = sampleProperties(
      preset.animate,
      (t % MOVE_DEMO_SECONDS) / MOVE_DEMO_SECONDS,
      MOVE_DEMO_SECONDS
    );
    return {
      dx: pose.dx,
      dy: pose.dy,
      scale: (pose.sx + pose.sy) / 2,
      rotate: pose.rotate,
      alpha: pose.alpha,
    };
  }
  if (slot === "loop") {
    return evalOverlayAnim({ loop: { style: style as OverlayLoopStyle, speed } }, t, 60, isText);
  }
  const cycle = demoCycle(ramp);
  const local = t % cycle;
  const anim =
    slot === "in"
      ? { in: { style: style as OverlayAnimStyle, seconds: ramp } }
      : { out: { style: style as OverlayAnimStyle, seconds: ramp } };
  // The exit sits at the tail of the window, so an Out tile rests first and
  // then leaves — the shape of the thing it is previewing.
  return evalOverlayAnim(anim, local, cycle, isText);
}

// The stage is the card's own width with no frame of its own: the card is
// already one, and a second inside it would both box the motion in and steal
// the room the motion needs. Clipping is what sells a slide leaving.
const STAGE = "grid h-12 w-full place-items-center overflow-hidden";
const WORD = "text-[13px] whitespace-nowrap";

/** The one face every demo name wears: bold enough that a letter still reads
 * mid-slide, open enough that a name fits the tile at 13px. */
const wordStyle = () => ({ fontFamily: fontStack("montserrat"), fontWeight: 700, lineHeight: 1 });

/** Whether the demo types its name out rather than moving it. A typed demo
 * rewrites the element's text every frame, so React must render it with no
 * children at all — a text node React still tracks would be destroyed under
 * it, and the crash lands later, when the tile unmounts. */
const typesItsName = (slot: Slot, style: string) =>
  slot === "in" || slot === "out" ? !!MOTION.edges[style]?.animate.typed : false;

/** Whether the demo has to lay the name out letter by letter: the per-glyph
 * ramps and the per-glyph loops both move each character on its own delay. */
const splitsGlyphs = (slot: Slot, style: string) =>
  slot === "move"
    ? false
    : slot === "loop"
      ? isGlyphLoopStyle(style as OverlayLoopStyle)
      : isGlyphAnimStyle(style as OverlayAnimStyle);

/** The name standing still: what a card wears until the pointer reaches it,
 * and what every tile falls back to when the reader asks for less motion. */
function FrozenName({ slot, style }: { slot: Slot; style: string }) {
  return (
    <span className={`${WORD} text-foreground`} style={wordStyle()}>
      {labelOf(slot, style)}
    </span>
  );
}

/** The style's name playing its own animation. The frames write styles straight
 * to the element: animating through React state would re-render the inspector
 * every frame for pixels React has no say over. */
function LiveName({
  slot,
  style,
  isText,
  seconds,
  speed,
  index = 0,
}: {
  slot: Slot;
  style: string;
  isText: boolean;
  seconds: number;
  speed: number;
  /** Place in the grid. It sets where in its own cycle this demo starts, so a
   * grid of them spreads out instead of running in unison. */
  index?: number;
}) {
  const ref = useRef<HTMLSpanElement>(null);
  const label = labelOf(slot, style);
  const typed = typesItsName(slot, style);
  // Golden-ratio steps around the cycle: neighbouring tiles land far apart in
  // it, and no run of them ever bunches up mid-motion together.
  const phase = index * (slot === "loop" ? LOOP_SPREAD : demoCycle(seconds)) * PHASE_STEP;
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    // A typed demo's element comes from React empty; its content is this
    // effect's to write, starting with the whole name.
    if (el.dataset.word) el.textContent = el.dataset.word;
    const letters = () => Array.from(el.children) as HTMLElement[];
    const rest = () => {
      el.style.transform = "";
      el.style.opacity = "";
      el.style.clipPath = "";
      for (const kid of letters()) {
        kid.style.transform = "";
        kid.style.opacity = "";
      }
      if (el.dataset.word) el.textContent = el.dataset.word;
    };
    if (window.matchMedia?.("(prefers-reduced-motion: reduce)").matches) return rest;
    let start = 0;
    let raf = 0;
    // Whether the last frame left per-letter styles on the children. A ramp
    // that ends off-stage leaves them at zero opacity, so the rest beat has to
    // hand the letters back before the word can read again.
    let glyphed = false;
    const tick = (now: number) => {
      if (!start) start = now;
      const st = demoStateAt(slot, style, (now - start) / 1000 + phase, isText, seconds, speed);
      const px = (v: number) => (v * el.clientWidth) / referencePx(slot, style);
      if (hasGlyphMotion(st)) {
        // The letters carry the motion; the word itself stays put.
        const kids = letters();
        kids.forEach((kid, i) => {
          const g = glyphStateAt(st, i, kids.length);
          kid.style.transform = `translate(${px(g.dx)}px, ${px(g.dy)}px) rotate(${g.rotate}deg) scale(${g.sx}, ${g.sy})`;
          kid.style.opacity = String(g.alpha);
        });
        glyphed = true;
      } else {
        if (glyphed) {
          for (const kid of letters()) {
            kid.style.transform = "";
            kid.style.opacity = "";
          }
          glyphed = false;
        }
        el.style.transform = `translate(${px(st.dx)}px, ${px(st.dy)}px) rotate(${st.rotate}deg) scale(${st.scale})`;
        el.style.opacity = String(st.alpha);
      }
      el.style.clipPath =
        st.reveal !== undefined ? `inset(0 ${(1 - st.reveal) * 100}% 0 0)` : "";
      if (st.textProgress !== undefined) {
        const word = el.dataset.word ?? "";
        el.textContent = word.slice(0, Math.ceil(st.textProgress * word.length));
      }
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    // Back to rest on the way out, so a card never freezes mid-animation.
    return () => {
      cancelAnimationFrame(raf);
      rest();
    };
  }, [slot, style, isText, seconds, speed, phase]);

  return (
    <span
      ref={ref}
      data-word={typed ? label : undefined}
      className={`${WORD} text-foreground`}
      style={{ willChange: "transform", ...wordStyle() }}
    >
      {typed
        ? null
        : isText && splitsGlyphs(slot, style)
          ? [...label].map((ch, i) => (
              <span key={i} className="inline-block">
                {ch}
              </span>
            ))
          : label}
    </span>
  );
}

/** The name in its tile: the motion itself while the tile is playing, the
 * plain name when it is not. */
function AnimName({
  playing,
  ...rest
}: {
  slot: Slot;
  style: string;
  isText: boolean;
  seconds: number;
  speed: number;
  playing: boolean;
  index?: number;
}) {
  return playing ? (
    <LiveName {...rest} />
  ) : (
    <FrozenName slot={rest.slot} style={rest.style} />
  );
}

/** Whether the element is on screen. A tile off the scroll's edge keeps its
 * name still and books no frames until it comes into view. */
function useOnScreen(ref: React.RefObject<HTMLElement | null>) {
  const [shown, setShown] = useState(false);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const io = new IntersectionObserver(([e]) => setShown(e.isIntersecting), {
      rootMargin: "64px",
    });
    io.observe(el);
    return () => io.disconnect();
  }, [ref]);
  return shown;
}

function AnimTile({
  slot,
  style,
  isText,
  seconds,
  speed,
  index,
  selected,
  onPick,
}: {
  slot: Slot;
  style: string;
  isText: boolean;
  seconds: number;
  speed: number;
  /** Place in the grid, which sets this tile's beat in the cascade. */
  index: number;
  selected: boolean;
  onPick: () => void;
}) {
  const ref = useRef<HTMLButtonElement>(null);
  const onScreen = useOnScreen(ref);
  return (
    <Tile
      ref={ref}
      selected={selected}
      onClick={onPick}
      title={labelOf(slot, style)}
      className="p-1"
    >
      <span className={STAGE}>
        <AnimName
          slot={slot}
          style={style}
          isText={isText}
          seconds={seconds}
          speed={speed}
          index={index}
          playing={onScreen}
        />
      </span>
    </Tile>
  );
}

/**
 * One picked style as a card outside the picker: the slot it fills in a
 * corner, the name playing what that slot does, and an × that clears the slot
 * on the spot. The card itself opens the picker.
 */
export function AnimationCard({
  slot,
  style,
  isText,
  seconds,
  speed,
  index = 0,
  onOpen,
  onClear,
}: {
  slot: Slot;
  style: string;
  isText: boolean;
  seconds: number;
  speed: number;
  /** Place in the row, which sets where in its cycle this card starts. */
  index?: number;
  onOpen: () => void;
  onClear: () => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const onScreen = useOnScreen(ref);
  const label = labelOf(slot, style);
  return (
    <div ref={ref} className="relative">
      <button
        type="button"
        title={`${label} — change`}
        className="flex w-full flex-col rounded-lg border border-border p-1 outline-none transition-colors hover:bg-muted/60"
        onClick={onOpen}
      >
        <span className={STAGE}>
          <AnimName
            slot={slot}
            style={style}
            isText={isText}
            seconds={seconds}
            speed={speed}
            index={index}
            playing={onScreen}
          />
        </span>
      </button>
      <span className="pointer-events-none absolute top-0.5 left-1.5 text-[9px] font-medium text-muted-foreground/70 capitalize">
        {slot}
      </span>
      <button
        type="button"
        aria-label={`No ${slot} animation`}
        title={`No ${slot} animation`}
        className="absolute top-0.5 right-0.5 grid size-4 place-items-center rounded-full text-muted-foreground/70 transition-colors hover:text-foreground"
        onClick={onClear}
      >
        <X className="size-3" />
      </button>
    </div>
  );
}

export function AnimationTiles({
  slot,
  value,
  custom,
  isText,
  seconds,
  speed,
  onPick,
}: {
  slot: Slot;
  /** The style in use, or undefined for none. */
  value?: string;
  /** The slot plays an animation the project carries itself, so none of these
   * tiles is what is running — including None. */
  custom?: boolean;
  /** Typewriter is offered on titles only. */
  isText: boolean;
  /** The In/Out length the panel has set — the hover demo's ramp. */
  seconds: number;
  /** The loop speed the panel has set — the hover demo's cycle rate. */
  speed: number;
  onPick: (style: string | null) => void;
}) {
  const ids: string[] =
    slot === "move"
      ? HOLD_IDS
      : slot === "loop"
        ? OVERLAY_LOOP_STYLE_IDS
        : OVERLAY_ANIM_STYLE_IDS.filter((s) => s !== "typewriter" || isText);

  return (
    <div className="grid grid-cols-2 gap-[9px]">
      <Tile selected={!value && !custom} onClick={() => onPick(null)} title="None" className="p-1">
        <span className={STAGE}>
          <span className={`${WORD} text-muted-foreground/70`} style={wordStyle()}>
            None
          </span>
        </span>
      </Tile>
      {ids.map((id, i) => (
        <AnimTile
          key={id}
          slot={slot}
          style={id}
          isText={isText}
          seconds={seconds}
          speed={speed}
          index={i}
          selected={value === id}
          onPick={() => onPick(id)}
        />
      ))}
    </div>
  );
}
