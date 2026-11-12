"use client";

import { useEffect, useRef } from "react";

// RMS below this reads as silence and draws no bar.
const SILENCE = 0.015;

/** Scrolling level meter fed by the stream's audio track; color follows CSS `color`.
 * `sampleMs` sets how much time each bar spans — larger values scroll slower and
 * cover a longer window (the loudest moment in the window wins). */
export function LiveWaveform({
  stream,
  className,
  sampleMs,
}: {
  stream: MediaStream;
  className?: string;
  sampleMs: number;
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  // Bar color follows CSS `color`. Resolve it only when the className changes
  // (i.e. when `recording` toggles) instead of every animation frame.
  const colorRef = useRef("");
  useEffect(() => {
    if (canvasRef.current) colorRef.current = getComputedStyle(canvasRef.current).color;
  }, [className]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || stream.getAudioTracks().length === 0) return;
    const audioCtx = new AudioContext();
    void audioCtx.resume().catch(() => {});
    const source = audioCtx.createMediaStreamSource(stream);
    const analyser = audioCtx.createAnalyser();
    analyser.fftSize = 1024;
    source.connect(analyser);
    const samples = new Uint8Array(analyser.fftSize);
    const levels: number[] = [];
    let raf = 0;
    let lastPush = 0;
    let peak = 0;

    const draw = (ts: number) => {
      raf = requestAnimationFrame(draw);
      analyser.getByteTimeDomainData(samples);
      let sum = 0;
      for (let i = 0; i < samples.length; i++) {
        const v = (samples[i] - 128) / 128;
        sum += v * v;
      }
      const rms = Math.sqrt(sum / samples.length);

      const dpr = window.devicePixelRatio || 1;
      const width = Math.round(canvas.clientWidth * dpr);
      const height = Math.round(canvas.clientHeight * dpr);
      if (canvas.width !== width) canvas.width = width;
      if (canvas.height !== height) canvas.height = height;
      const barWidth = 3 * dpr;
      const step = barWidth + 2 * dpr;
      const maxBars = Math.max(1, Math.floor(width / step));

      const g = canvas.getContext("2d");
      if (!g) return;
      g.clearRect(0, 0, width, height);
      g.fillStyle = colorRef.current || getComputedStyle(canvas).color;
      // Idle input draws a row of small centered dots so the meter reads as a
      // ready track spanning the whole width; sound grows each into a bar.
      const idle = barWidth;
      const bar = (x: number, level: number) => {
        if (x + barWidth < 0 || x > width) return;
        const h = level >= SILENCE ? Math.max(idle, Math.min(1, level * 3) * height) : idle;
        const r = Math.min(barWidth / 2, h / 2);
        g.beginPath();
        g.roundRect(x, (height - h) / 2, barWidth, h, r);
        g.fill();
      };

      // Commit one bar per `sampleMs` (that's the time scale) but slide the whole
      // strip left every frame by the fraction of the window elapsed, so motion
      // is continuous instead of ticking a full bar at once. Committed bars hold
      // the window's peak; a forming bar at the right edge tracks the live level.
      if (lastPush === 0) lastPush = ts;
      peak = Math.max(peak, rms);
      if (ts - lastPush >= sampleMs) {
        levels.push(peak);
        peak = 0;
        lastPush = ts;
      }
      while (levels.length < maxBars + 1) levels.unshift(0);
      if (levels.length > maxBars + 2) levels.splice(0, levels.length - (maxBars + 2));
      const offset = Math.min(1, (ts - lastPush) / sampleMs) * step;
      const n = levels.length;
      for (let i = 0; i < n; i++) bar(width - step - (n - i) * step - offset, levels[i]);
      bar(width - step - offset, rms);
    };
    raf = requestAnimationFrame(draw);

    return () => {
      cancelAnimationFrame(raf);
      source.disconnect();
      void audioCtx.close().catch(() => {});
    };
  }, [stream, sampleMs]);

  return <canvas ref={canvasRef} className={className} />;
}
