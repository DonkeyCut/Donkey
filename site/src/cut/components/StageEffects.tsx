"use client";

import { useEffect, useMemo, useRef } from "react";
import {
  burnGradient,
  burnStreakGradient,
  grainTileUrl,
  isAudioEffect,
  LEAK_TINT,
  leakGradient,
  streakGradient,
  washBackground,
} from "@donkeycut/effects-kit";
import { previewAt, subscribePlayhead, usePreviewTime } from "@/cut/lib/playhead";
import { useEditor } from "@/cut/lib/store";
import { isEffectOverlay, laneOf } from "@/cut/lib/types";
import {
  hasEffects,
  liveEffectsAt,
  stageEffectFilter,
  stageEffectTransform,
  type LiveEffect,
} from "@/cut/lib/effectStack";
import "./grain.css";
import { rgbSplitFilter } from "./rgbSplit";

/**
 * Effect elements in the preview's stack.
 *
 * An effect filters whatever plays under it: the footage and every element on
 * a lane below its own. What that means for the stage — which slice wears
 * which grade — is `effectStack.ts`; this file reads the document for it and
 * paints the frame-wide passes (grain, vignette, leak wash, flash) that sit
 * where the effect does.
 *
 * Both exports walk the same stack, so what plays here is what renders.
 */

export { stageEffectTransform, stageSliceStructure, type LiveEffect, type StageSlice } from "@/cut/lib/effectStack";

/**
 * Every effect live right now, deepest lane last. Skimming previews them too,
 * the same as the elements beside them.
 *
 * This subscribes at frame rate, so only the leaves of the stage call it — the
 * paints of one lane, the elements of one band. The component that lays the
 * stage out stays off the clock.
 */
export function useLiveEffects(): LiveEffect[] {
  const overlays = useEditor((s) => s.overlays);
  const t = usePreviewTime();
  return useMemo(() => liveEffectsAt(overlays, t), [overlays, t]);
}

/**
 * Wear the whole stack's grade and frame motion over the picture.
 *
 * The picture is a canvas the engine paints imperatively, and its grade is two
 * style properties on the box around it. Writing them from a subscription keeps
 * a project with no effects at zero React work per frame, and one with effects
 * at two string comparisons.
 */
export function StagePictureFx({ children }: { children: React.ReactNode }) {
  const overlays = useEditor((s) => s.overlays);
  const ref = useRef<HTMLDivElement>(null);
  const ghostRef = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    // A glitch's split doubles the picture: the unmoved frame is copied off
    // the picture canvas onto one laid over the moved box, lightened in. The
    // copy only runs on the frames a split is live.
    const paintGhost = (alpha: number) => {
      const ghost = ghostRef.current;
      if (!ghost) return;
      if (alpha <= 0) {
        if (ghost.style.display !== "none") ghost.style.display = "none";
        return;
      }
      // The picture shows on the SDR canvas, or on the present canvas over
      // it in HDR; the hidden one is skipped.
      let source: HTMLCanvasElement | null = null;
      for (const c of ref.current?.querySelectorAll("canvas") ?? []) {
        if (!c.classList.contains("hidden")) source = c;
      }
      const ctx = ghost.getContext("2d");
      if (!source || !ctx || source.width === 0) return;
      if (ghost.width !== source.width) ghost.width = source.width;
      if (ghost.height !== source.height) ghost.height = source.height;
      ctx.clearRect(0, 0, ghost.width, ghost.height);
      ctx.drawImage(source, 0, 0);
      ghost.style.opacity = String(alpha);
      ghost.style.display = "block";
    };
    const write = (filter: string, transform: string) => {
      const style = ref.current?.style;
      if (!style) return;
      if (style.filter !== filter) style.filter = filter;
      if (style.transform !== transform) style.transform = transform;
    };
    if (!hasEffects(overlays)) {
      write("", "");
      paintGhost(0);
      return;
    }
    const apply = () => {
      const states = liveEffectsAt(overlays, previewAt()).map((e) => e.state);
      const box = ref.current;
      const split = box ? rgbSplitFilter(states, box.clientWidth, box.clientHeight) : "";
      write([stageEffectFilter(states), split].filter(Boolean).join(" "), stageEffectTransform(states) ?? "");
      paintGhost(Math.max(0, ...states.map((s) => s.ghost ?? 0)));
    };
    apply();
    const stop = subscribePlayhead(apply);
    return () => {
      stop();
      write("", "");
      paintGhost(0);
    };
  }, [overlays]);
  return (
    <>
      <div ref={ref} className="absolute inset-0">
        {children}
      </div>
      <canvas ref={ghostRef} className="pointer-events-none absolute inset-0 size-full mix-blend-lighten" style={{ display: "none" }} />
    </>
  );
}

/** The lanes picture effects sit on, whether or not one is live right now. The
 * stage splits on these, so its slices stay put while the playhead moves and
 * only change when a row does. An audio effect treats the mix, so its row
 * splits nothing. */
export function useEffectLanes(): number[] {
  const overlays = useEditor((s) => s.overlays);
  return useMemo(
    () => [
      ...new Set(
        overlays.filter((o) => isEffectOverlay(o) && !isAudioEffect(o.effect)).map(laneOf)
      ),
    ].sort((a, b) => a - b),
    [overlays]
  );
}

/** The frame-wide paints of the effects on one lane, over everything under
 * them and under everything above. */
export function StageEffectPaint({ lane }: { lane: number }) {
  const live = useLiveEffects();
  const states = useMemo(
    () => live.filter((e) => e.lane === lane).map((e) => e.state),
    [live, lane]
  );
  if (states.length === 0) return null;
  const grainUrl = grainTileUrl();
  const grain = Math.max(0, ...states.map((s) => s.grain ?? 0));
  const vignette = Math.max(0, ...states.map((s) => s.vignette ?? 0));
  const flash = Math.max(0, ...states.map((s) => (s.flashTone ? 0 : (s.flash ?? 0))));
  const dark = Math.max(0, ...states.map((s) => (s.flashTone === "black" ? (s.flash ?? 0) : 0)));
  const washes = states.flatMap((s) => s.washes ?? []);
  const leaks = states.flatMap((s) => (s.leak ? [s.leak] : []));
  const burns = states.flatMap((s) => (s.burn ? [s.burn] : []));
  if (!grain && !vignette && !flash && !dark && washes.length === 0 && leaks.length === 0 && burns.length === 0) return null;
  return (
    <div className="pointer-events-none absolute inset-0">
      {grain > 0 && grainUrl && (
        <div
          className="cut-grain absolute inset-0"
          style={{ opacity: grain, backgroundImage: `url(${grainUrl})` }}
        />
      )}
      {vignette > 0 && (
        <div
          className="absolute inset-0"
          style={{
            background: `radial-gradient(circle at 50% 50%, transparent 35%, rgba(0,0,0,${vignette.toFixed(3)}) 100%)`,
          }}
        />
      )}
      {leaks.map((l, i) => (
        // Each gradient — the bloom, then every streak band — lands twice,
        // the canvas pass's two blends: screen lights the darks, the plain
        // layer tints the brights.
        <div key={`leak-${i}`} className="absolute inset-0">
          {[leakGradient(l.x, l.y), ...l.streaks.map(streakGradient)].map((bg, j) => {
            const alpha = j === 0 ? l.alpha : l.streaks[j - 1].alpha;
            return (
              <div key={j} className="absolute inset-0">
                <div
                  className="absolute inset-0 mix-blend-screen"
                  style={{ opacity: alpha, background: bg }}
                />
                <div
                  className="absolute inset-0"
                  style={{ opacity: alpha * LEAK_TINT, background: bg }}
                />
              </div>
            );
          })}
        </div>
      ))}
      {washes.map((w, i) => (
        <div
          key={i}
          className="absolute inset-0"
          style={{
            background: washBackground(w.color, w.area),
            opacity: w.alpha,
            // The recipe names its wash with a canvas composite op; the ones
            // effects use are CSS blend modes by the same name.
            mixBlendMode: w.mode as React.CSSProperties["mixBlendMode"],
          }}
        />
      ))}
      {flash > 0 && <div className="absolute inset-0 bg-white" style={{ opacity: flash }} />}
      {dark > 0 && <div className="absolute inset-0 bg-black" style={{ opacity: dark }} />}
      {burns.map((b, i) => (
        // The burned body, then the flame band over it — the canvas pass's
        // two gradients at the same alphas.
        <div key={`burn-${i}`} className="absolute inset-0">
          <div className="absolute inset-0" style={{ opacity: b.alpha, background: burnGradient(b) }} />
          {b.streak && (
            <div
              className="absolute inset-0"
              style={{ opacity: b.streak.alpha * b.alpha, background: burnStreakGradient(b.streak) }}
            />
          )}
        </div>
      ))}
    </div>
  );
}
