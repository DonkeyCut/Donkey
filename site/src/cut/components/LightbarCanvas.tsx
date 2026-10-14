"use client";

import { useEffect, useLayoutEffect, useRef } from "react";
import { LIGHTBAR_STOPS, type LightBar } from "@donkeycut/effects-kit";

/** Texels across one bar's profile sprite. */
const SPRITE_TEXELS = 256;

const STOP_LO = LIGHTBAR_STOPS[0].d;
const STOP_HI = LIGHTBAR_STOPS[LIGHTBAR_STOPS.length - 1].d;

/** One bar's profile per ribbon color, drawn once and stretched over every
 * bar of that color. The ribbon shares its palette tuples, so the tuple is
 * the key and a frame looks sprites up without building a string. */
const sprites = new WeakMap<LightBar["rgb"], HTMLCanvasElement>();

function spriteOf(rgb: LightBar["rgb"]): HTMLCanvasElement | null {
  const hit = sprites.get(rgb);
  if (hit) {
    return hit;
  }
  const c = document.createElement("canvas");
  c.width = SPRITE_TEXELS;
  c.height = 1;
  const ctx = c.getContext("2d");
  if (!ctx) {
    return null;
  }
  const g = ctx.createLinearGradient(0, 0, SPRITE_TEXELS, 0);
  for (const st of LIGHTBAR_STOPS) {
    g.addColorStop((st.d - STOP_LO) / (STOP_HI - STOP_LO), `rgba(${rgb[0]},${rgb[1]},${rgb[2]},${st.f})`);
  }
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, SPRITE_TEXELS, 1);
  sprites.set(rgb, c);
  return c;
}

/** Add every bar into the one-pixel row, each its sprite at its opacity. */
function paintBars(c: HTMLCanvasElement, bars: LightBar[]) {
  const ctx = c.getContext("2d");
  if (!ctx) {
    return;
  }
  const W = c.width;
  ctx.globalCompositeOperation = "source-over";
  ctx.globalAlpha = 1;
  ctx.clearRect(0, 0, W, 1);
  ctx.globalCompositeOperation = "lighter";
  for (const b of bars) {
    const sprite = spriteOf(b.rgb);
    if (!sprite) {
      continue;
    }
    ctx.globalAlpha = b.alpha;
    ctx.drawImage(sprite, (b.x + STOP_LO * b.w) * W, 0, (STOP_HI - STOP_LO) * b.w * W, 1);
  }
}

/**
 * Light bars added onto the picture, the DOM twin of the canvas pass. Bars
 * are full-height and vary only across, so they paint into a single row of
 * pixels that CSS stretches to the frame: a frame of bars is one draw per bar
 * and one composited layer, however many are up.
 */
export function LightbarCanvas({ bars }: { bars: LightBar[] }) {
  const ref = useRef<HTMLCanvasElement>(null);
  const latest = useRef(bars);

  // Repaint on every new set of bars, before the frame shows.
  useLayoutEffect(() => {
    latest.current = bars;
    if (ref.current) {
      paintBars(ref.current, bars);
    }
  }, [bars]);

  // The row is as wide as the box in device pixels; a resize repaints it.
  useEffect(() => {
    const c = ref.current;
    if (!c) {
      return;
    }
    const ro = new ResizeObserver(([entry]) => {
      const w = Math.max(1, Math.round(entry.contentRect.width * window.devicePixelRatio));
      if (c.width === w) {
        return;
      }
      c.width = w;
      paintBars(c, latest.current);
    });
    ro.observe(c);
    return () => ro.disconnect();
  }, []);

  return (
    <canvas
      ref={ref}
      height={1}
      className="pointer-events-none absolute inset-0 size-full"
      style={{ mixBlendMode: "plus-lighter" }}
    />
  );
}
