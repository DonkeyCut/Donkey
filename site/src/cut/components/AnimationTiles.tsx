"use client";

import { useEffect, useRef, useState } from "react";
import { Ban, Image as ImageIcon } from "lucide-react";
import {
  evalOverlayAnim,
  OVERLAY_ANIM_STYLE_IDS,
  OVERLAY_ANIM_STYLE_LABELS,
  OVERLAY_LOOP_STYLE_IDS,
  OVERLAY_LOOP_STYLE_LABELS,
  type OverlayAnimStyle,
  type OverlayLoopStyle,
} from "@donkeycut/effects-kit";
import { Tile } from "@/cut/components/PanelTile";

/**
 * The animation picker: a grid of tiles that play their animation on a
 * stand-in shape, so the motion is chosen by watching rather than by reading a
 * name. Only the tile under the pointer moves — a dozen shapes all cycling at
 * once is noise, and it makes the one you are actually looking at harder to
 * read.
 *
 * Every tile samples `evalOverlayAnim` — the same function the preview, the
 * in-tab export and the frame sampler use. A tile therefore cannot promise
 * motion the export will not deliver, and a new style animates here the moment
 * the evaluator learns it.
 */

/** Demo timing: a ramp, then a beat of rest, then round again. */
const DEMO_RAMP = 0.6;
const DEMO_HOLD = 0.55;
const DEMO_CYCLE = DEMO_RAMP + DEMO_HOLD;

/** Design px that map to the tile's preview stage. The evaluator works in px at
 * a 1080 short side; a slide travels 120 of them, which has to read inside a
 * stage a few dozen pixels wide. Low enough that a slide clearly leaves. */
const DEMO_REFERENCE_PX = 190;

/** What a typewriter tile types. */
const DEMO_WORD = "Text";

type Slot = "in" | "out" | "loop";

function demoStateAt(slot: Slot, style: string, t: number) {
  if (slot === "loop") {
    return evalOverlayAnim({ loop: { style: style as OverlayLoopStyle, speed: 1 } }, t, 60);
  }
  const local = t % DEMO_CYCLE;
  const anim =
    slot === "in"
      ? { in: { style: style as OverlayAnimStyle, seconds: DEMO_RAMP } }
      : { out: { style: style as OverlayAnimStyle, seconds: DEMO_RAMP } };
  // The exit sits at the tail of the window, so an Out tile rests first and
  // then leaves — the shape of the thing it is previewing.
  return evalOverlayAnim(anim, local, DEMO_CYCLE);
}

export function AnimationTiles({
  slot,
  value,
  isText,
  onPick,
}: {
  slot: Slot;
  /** The style in use, or undefined for none. */
  value?: string;
  /** Typewriter is offered on titles only. */
  isText: boolean;
  onPick: (style: string | null) => void;
}) {
  const ids: string[] =
    slot === "loop"
      ? OVERLAY_LOOP_STYLE_IDS
      : OVERLAY_ANIM_STYLE_IDS.filter((s) => s !== "typewriter" || isText);
  const labels: Record<string, string> =
    slot === "loop" ? OVERLAY_LOOP_STYLE_LABELS : OVERLAY_ANIM_STYLE_LABELS;

  // One clock for the whole grid, writing transforms straight to the elements:
  // a dozen tiles animating through React state would re-render the inspector
  // every frame for pixels React has no say over.
  const shapes = useRef(new Map<string, HTMLElement>());
  const register = (id: string) => (el: HTMLElement | null) => {
    if (el) shapes.current.set(id, el);
    else shapes.current.delete(id);
  };

  const [hovered, setHovered] = useState<string | null>(null);

  useEffect(() => {
    const el = hovered ? shapes.current.get(hovered) : null;
    if (!el) return;
    const rest = () => {
      el.style.transform = "";
      el.style.opacity = "";
      if (el.dataset.word) el.textContent = el.dataset.word;
    };
    if (window.matchMedia?.("(prefers-reduced-motion: reduce)").matches) return rest;
    let start = 0;
    let raf = 0;
    const tick = (now: number) => {
      if (!start) start = now;
      const st = demoStateAt(slot, hovered!, (now - start) / 1000);
      const px = (v: number) => (v * el.clientWidth) / DEMO_REFERENCE_PX;
      el.style.transform = `translate(${px(st.dx)}px, ${px(st.dy)}px) rotate(${st.rotate}deg) scale(${st.scale})`;
      el.style.opacity = String(st.alpha);
      if (st.textProgress !== undefined) {
        el.textContent = DEMO_WORD.slice(0, Math.ceil(st.textProgress * DEMO_WORD.length));
      }
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    // Back to rest on the way out, so a tile never freezes mid-animation.
    return () => {
      cancelAnimationFrame(raf);
      rest();
    };
  }, [hovered, slot]);

  // The stage is the tile's own width with no frame of its own: the tile is
  // already a card, and a second one inside it would both box the motion in and
  // steal the room the motion needs. Clipping is what sells a slide leaving.
  const stage = "grid h-11 w-full place-items-center overflow-hidden";
  const tile = "gap-1 px-1 pt-1.5 pb-1";

  return (
    <div className="grid grid-cols-3 gap-1.5">
      <Tile selected={!value} onClick={() => onPick(null)} label="None" className={tile}>
        <span className={stage}>
          <Ban className="size-7 text-muted-foreground/60" />
        </span>
      </Tile>
      {ids.map((id) => (
        <Tile
          key={id}
          selected={value === id}
          onClick={() => onPick(id)}
          label={labels[id]}
          className={tile}
          onHover={(on) => setHovered(on ? id : (h) => (h === id ? null : h))}
        >
          <span className={stage}>
            {id === "typewriter" ? (
              <span
                ref={register(id)}
                data-word={DEMO_WORD}
                className="text-[13px] font-semibold text-foreground"
                style={{ willChange: "transform" }}
              >
                {DEMO_WORD}
              </span>
            ) : (
              // Its own wrapper, so the animated transform never fights the
              // icon's sizing.
              <span ref={register(id)} className="block" style={{ willChange: "transform" }}>
                {/* Carries the tile's own muted color and the light stroke the
                    transition tiles use, so a grid of stand-ins doesn't read
                    heavier than the picture it stands in for. */}
                <ImageIcon className="size-7" strokeWidth={1.5} />
              </span>
            )}
          </span>
        </Tile>
      ))}
    </div>
  );
}
