/**
 * Polygon outlines shared by every painter: shape elements, their DOM
 * previews, and mask coverage all trace the same geometry through one sink,
 * so a heart drawn as a shape and a heart cut as a mask are the same heart.
 */

import type { ShapeKind } from "./types";

/** A path consumer — a canvas context is one, and `shapePathD` builds SVG
 * path data through the same calls, so both draw identical geometry. */
export interface ShapePathSink {
  moveTo(x: number, y: number): void;
  lineTo(x: number, y: number): void;
  bezierCurveTo(c1x: number, c1y: number, c2x: number, c2y: number, x: number, y: number): void;
  closePath(): void;
}

/** Trace a polygon shape's outline into a w×h box whose top-left corner sits
 * at (dx, dy). Covers the filled kinds beyond rect and ellipse. */
export function tracePolyShape(
  p: ShapePathSink,
  kind: ShapeKind,
  w: number,
  h: number,
  dx = 0,
  dy = 0
) {
  const X = (f: number) => dx + f * w;
  const Y = (f: number) => dy + f * h;
  if (kind === "triangle") {
    p.moveTo(X(0.5), Y(0));
    p.lineTo(X(1), Y(1));
    p.lineTo(X(0), Y(1));
  } else if (kind === "diamond") {
    p.moveTo(X(0.5), Y(0));
    p.lineTo(X(1), Y(0.5));
    p.lineTo(X(0.5), Y(1));
    p.lineTo(X(0), Y(0.5));
  } else if (kind === "hexagon") {
    // Lucide's hexagon stands on a point: vertices top and bottom, straight
    // vertical sides.
    p.moveTo(X(0.5), Y(0));
    p.lineTo(X(1), Y(0.25));
    p.lineTo(X(1), Y(0.75));
    p.lineTo(X(0.5), Y(1));
    p.lineTo(X(0), Y(0.75));
    p.lineTo(X(0), Y(0.25));
  } else if (kind === "star") {
    // Lucide's star: the inner ring at half the outer radius so the points
    // read full-bodied, and rounded corners — a soft round in each inner
    // notch, a slight one at each tip. Each corner is cut short along its
    // two edges and bridged by a cubic whose controls sit on the vertex.
    const pts: [number, number][] = [];
    for (let i = 0; i < 10; i++) {
      const r = i % 2 ? 0.5 : 1;
      const a = -Math.PI / 2 + (i * Math.PI) / 5;
      pts.push([0.5 + 0.5 * r * Math.cos(a), 0.5 + 0.5 * r * Math.sin(a)]);
    }
    for (let i = 0; i < 10; i++) {
      const [px, py] = pts[(i + 9) % 10];
      const [cx, cy] = pts[i];
      const [nx, ny] = pts[(i + 1) % 10];
      const cut = i % 2 ? 0.35 : 0.15;
      const ex = cx + (px - cx) * cut;
      const ey = cy + (py - cy) * cut;
      const lx = cx + (nx - cx) * cut;
      const ly = cy + (ny - cy) * cut;
      if (i === 0) p.moveTo(X(ex), Y(ey));
      else p.lineTo(X(ex), Y(ey));
      p.bezierCurveTo(X(cx), Y(cy), X(cx), Y(cy), X(lx), Y(ly));
    }
  } else if (kind === "heart") {
    // Lucide's heart, normalized to the unit box (its arcs as cubics):
    // straight sides down to the tip, round quarter-circle lobes on top.
    p.moveTo(X(0.5), Y(1));
    p.lineTo(X(0.15), Y(0.611));
    p.bezierCurveTo(X(0.075), Y(0.531), X(0), Y(0.433), X(0), Y(0.306));
    p.bezierCurveTo(X(0), Y(0.137), X(0.123), Y(0), X(0.275), Y(0));
    p.bezierCurveTo(X(0.363), Y(0), X(0.425), Y(0.028), X(0.5), Y(0.111));
    p.bezierCurveTo(X(0.575), Y(0.028), X(0.637), Y(0), X(0.725), Y(0));
    p.bezierCurveTo(X(0.877), Y(0), X(1), Y(0.137), X(1), Y(0.306));
    p.bezierCurveTo(X(1), Y(0.433), X(0.925), Y(0.531), X(0.85), Y(0.611));
  }
  p.closePath();
}

/** A polygon shape as SVG path data for a w×h box whose top-left corner
 * sits at (dx, dy), for the DOM preview. */
export function shapePathD(kind: ShapeKind, w: number, h: number, dx = 0, dy = 0): string {
  const parts: string[] = [];
  const n = (v: number) => String(+v.toFixed(2));
  tracePolyShape(
    {
      moveTo: (x, y) => parts.push(`M${n(x)} ${n(y)}`),
      lineTo: (x, y) => parts.push(`L${n(x)} ${n(y)}`),
      bezierCurveTo: (c1x, c1y, c2x, c2y, x, y) =>
        parts.push(`C${n(c1x)} ${n(c1y)} ${n(c2x)} ${n(c2y)} ${n(x)} ${n(y)}`),
      closePath: () => parts.push("Z"),
    },
    kind,
    w,
    h,
    dx,
    dy
  );
  return parts.join(" ");
}
