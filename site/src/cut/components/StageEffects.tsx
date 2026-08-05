"use client";

import { useMemo } from "react";
import {
  effectPreviewState,
  grainTileUrl,
  LEAK_TINT,
  leakGradient,
  streakGradient,
  type EffectPreviewState,
} from "@donkeycut/effects-kit";
import { useEditor } from "@/cut/lib/store";
import { isEffectOverlay, laneOf } from "@/cut/lib/types";
import type { LiveEffect } from "@/cut/lib/effectStack";
import "./grain.css";

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

export { stageEffectTransform, stageSlices, type LiveEffect, type StageSlice } from "@/cut/lib/effectStack";

/** Every effect live at `t`, deepest lane last. Skimming previews them too,
 * the same as the elements beside them. */
export function useStageEffects(): LiveEffect[] {
  const overlays = useEditor((s) => s.overlays);
  const currentTime = useEditor((s) => s.currentTime);
  const skimTime = useEditor((s) => s.skimTime);
  const playing = useEditor((s) => s.playing);
  const t = !playing && skimTime !== null ? skimTime : currentTime;
  return useMemo(
    () =>
      overlays
        .filter(isEffectOverlay)
        .filter((o) => !o.hidden && t >= o.start && t <= o.end)
        .map((o) => ({
          lane: laneOf(o),
          state: effectPreviewState(o.effect, o.amount, t - o.start, o.focus, o.ramp, o.end - o.start),
        }))
        .sort((a, b) => a.lane - b.lane),
    [overlays, t]
  );
}

/** The lanes effects sit on, whether or not one is live right now. The stage
 * splits on these, so its slices stay put while the playhead moves and only
 * change when a row does. */
export function useEffectLanes(): number[] {
  const overlays = useEditor((s) => s.overlays);
  return useMemo(
    () => [...new Set(overlays.filter(isEffectOverlay).map(laneOf))].sort((a, b) => a - b),
    [overlays]
  );
}

/** The frame-wide paints of the effects on one lane, over everything under
 * them and under everything above. */
export function StageEffectPaint({ states }: { states: EffectPreviewState[] }) {
  if (states.length === 0) return null;
  const grainUrl = grainTileUrl();
  const grain = Math.max(0, ...states.map((s) => s.grain ?? 0));
  const vignette = Math.max(0, ...states.map((s) => s.vignette ?? 0));
  const flash = Math.max(0, ...states.map((s) => s.flash ?? 0));
  const washes = states.flatMap((s) => s.washes ?? []);
  const leaks = states.flatMap((s) => (s.leak ? [s.leak] : []));
  if (!grain && !vignette && !flash && washes.length === 0 && leaks.length === 0) return null;
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
            background: w.color,
            opacity: w.alpha,
            // The recipe names its wash with a canvas composite op; the ones
            // effects use are CSS blend modes by the same name.
            mixBlendMode: w.mode as React.CSSProperties["mixBlendMode"],
          }}
        />
      ))}
      {flash > 0 && <div className="absolute inset-0 bg-white" style={{ opacity: flash }} />}
    </div>
  );
}
