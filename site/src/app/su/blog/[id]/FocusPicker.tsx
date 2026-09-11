"use client";

import { useRef, useState } from "react";

import { blogFocusSchema } from "@/lib/blog/schema";
import { cn } from "@/lib/utils";

// The picture in the box the page crops it to. Dragging moves the picture
// under the box, so whatever matters in it can be brought into frame; the
// result is kept as an object-position pair and the public page positions
// the same way. The picture only moves along an axis it overflows.
export function FocusPicker({
  src,
  alt,
  focus,
  className,
  onChange,
}: {
  src: string;
  alt: string;
  focus: string | null;
  className?: string;
  onChange: (focus: string) => void;
}) {
  const box = useRef<HTMLDivElement>(null);
  const [natural, setNatural] = useState<{ width: number; height: number } | null>(null);
  const drag = useRef<{ x: number; y: number; fx: number; fy: number } | null>(null);
  const position = focus && blogFocusSchema.safeParse(focus).success ? focus : "50% 50%";

  const moveTo = (event: React.PointerEvent) => {
    const start = drag.current;
    const rect = box.current?.getBoundingClientRect();
    if (!start || !rect || !natural) return;
    // object-fit: cover scales the picture until it fills the box; what hangs
    // over the box is the room there is to move it.
    const scale = Math.max(rect.width / natural.width, rect.height / natural.height);
    const overX = natural.width * scale - rect.width;
    const overY = natural.height * scale - rect.height;
    const fx = overX > 0 ? start.fx - ((event.clientX - start.x) / overX) * 100 : start.fx;
    const fy = overY > 0 ? start.fy - ((event.clientY - start.y) / overY) * 100 : start.fy;
    const clamp = (value: number) => Math.min(100, Math.max(0, value));
    onChange(`${clamp(fx).toFixed(1)}% ${clamp(fy).toFixed(1)}%`);
  };

  return (
    <div
      ref={box}
      className={cn(
        "relative w-full cursor-grab touch-none overflow-hidden rounded-2xl bg-muted select-none active:cursor-grabbing",
        className,
      )}
      onPointerDown={(event) => {
        const [fx, fy] = position.split(" ").map(parseFloat);
        drag.current = { x: event.clientX, y: event.clientY, fx, fy };
        event.currentTarget.setPointerCapture(event.pointerId);
      }}
      onPointerMove={(event) => {
        if (drag.current) moveTo(event);
      }}
      onPointerUp={(event) => {
        drag.current = null;
        event.currentTarget.releasePointerCapture(event.pointerId);
      }}
      onPointerCancel={() => {
        drag.current = null;
      }}
    >
      {/* eslint-disable-next-line @next/next/no-img-element -- pre-encoded AVIF from the media host, not Next-optimizable */}
      <img
        src={src}
        alt={alt}
        draggable={false}
        className="size-full object-cover"
        style={{ objectPosition: position }}
        onLoad={(event) => {
          const img = event.currentTarget;
          setNatural({ width: img.naturalWidth, height: img.naturalHeight });
        }}
      />
    </div>
  );
}
