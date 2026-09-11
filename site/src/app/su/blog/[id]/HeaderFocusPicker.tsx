"use client";

import { useRef } from "react";

import { blogFocusSchema } from "@/lib/blog/schema";

// The header at the crop the article uses (full column width, 240px tall).
// Clicking or dragging on it names the point that has to stay in frame, kept
// as an object-position pair so the public page positions the same way.
export function HeaderFocusPicker({
  src,
  alt,
  focus,
  onChange,
}: {
  src: string;
  alt: string;
  focus: string | null;
  onChange: (focus: string) => void;
}) {
  const box = useRef<HTMLDivElement>(null);
  const dragging = useRef(false);
  const position = focus && blogFocusSchema.safeParse(focus).success ? focus : "50% 50%";
  const [x, y] = position.split(" ");

  const setFrom = (event: React.PointerEvent) => {
    const rect = box.current?.getBoundingClientRect();
    if (!rect) return;
    const px = Math.min(100, Math.max(0, ((event.clientX - rect.left) / rect.width) * 100));
    const py = Math.min(100, Math.max(0, ((event.clientY - rect.top) / rect.height) * 100));
    onChange(`${px.toFixed(1)}% ${py.toFixed(1)}%`);
  };

  return (
    <div
      ref={box}
      className="relative h-60 w-full cursor-crosshair touch-none overflow-hidden rounded-2xl border-2 border-ink bg-muted select-none"
      onPointerDown={(event) => {
        dragging.current = true;
        event.currentTarget.setPointerCapture(event.pointerId);
        setFrom(event);
      }}
      onPointerMove={(event) => {
        if (dragging.current) setFrom(event);
      }}
      onPointerUp={(event) => {
        dragging.current = false;
        event.currentTarget.releasePointerCapture(event.pointerId);
      }}
      onPointerCancel={() => {
        dragging.current = false;
      }}
    >
      {/* eslint-disable-next-line @next/next/no-img-element -- pre-encoded AVIF from the media host, not Next-optimizable */}
      <img src={src} alt={alt} draggable={false} className="size-full object-cover" style={{ objectPosition: position }} />
      <div
        aria-hidden
        className="pointer-events-none absolute size-5 -translate-x-1/2 -translate-y-1/2 rounded-full border-2 border-white bg-coral shadow"
        style={{ left: x, top: y }}
      />
    </div>
  );
}
