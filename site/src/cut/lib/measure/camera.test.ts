import { describe, expect, test } from "bun:test";
import { cameraPath, holdsStill, type Gray } from "./camera";

// A picture that goes on past the frame: a sum of waves, so any zoom, shift or
// turn of it can be drawn exactly.
const WAVES = Array.from({ length: 14 }, (_, i) => ({
  fx: Math.cos(i * 2.4) * (0.2 + 0.08 * (i % 5)),
  fy: Math.sin(i * 2.4) * (0.2 + 0.08 * (i % 5)),
  ph: i * 1.7,
}));
/** `live` walks a bright subject across the picture, as a skier moves through
 * a live shot under the camera. */
const picture = (x: number, y: number, live = 0) =>
  128 +
  WAVES.reduce((v, w) => v + 9 * Math.sin(w.fx * x + w.fy * y + w.ph), 0) +
  (live ? 90 * Math.exp(-((x - 30 + live * 6) ** 2 + (y - 5) ** 2) / 120) : 0);

/** The picture as the camera sees it at a pose: what sits at (x, y) on the
 * frame is the picture's point there with the move undone about the centre. */
function shot(pose: { scale: number; dx: number; dy: number; rotation: number }, live = 0, w = 192, h = 108): Gray {
  const data = new Float32Array(w * h);
  const cx = (w - 1) / 2;
  const cy = (h - 1) / 2;
  const th = (pose.rotation * Math.PI) / 180;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const px = x - cx - pose.dx * w;
      const py = y - cy - pose.dy * h;
      const rx = (Math.cos(th) * px + Math.sin(th) * py) / pose.scale;
      const ry = (-Math.sin(th) * px + Math.cos(th) * py) / pose.scale;
      data[y * w + x] = picture(rx, ry, live);
    }
  }
  return { width: w, height: h, data };
}

describe("cameraPath", () => {
  test("finds a beat zoom with a nudge and a tilt", () => {
    const poses = [
      { scale: 1, dx: 0, dy: 0, rotation: 0 },
      { scale: 1.04, dx: 0.01, dy: -0.005, rotation: 0.6 },
      { scale: 1.085, dx: 0.02, dy: 0.01, rotation: -1.2 },
      { scale: 1.02, dx: -0.015, dy: 0.02, rotation: 0.3 },
    ];
    const path = cameraPath(poses.map((p) => shot(p)));
    path.forEach((got, i) => {
      expect(Math.abs(got.scale - poses[i].scale)).toBeLessThan(0.006);
      expect(Math.abs(got.dx - poses[i].dx)).toBeLessThan(0.004);
      expect(Math.abs(got.dy - poses[i].dy)).toBeLessThan(0.006);
      expect(Math.abs(got.rotation - poses[i].rotation)).toBeLessThan(0.3);
      expect(got.residual).toBeLessThan(3);
    });
  });

  test("follows a shake that walks far from where it began", () => {
    const poses = Array.from({ length: 8 }, (_, i) => ({ scale: 1.05, dx: 0, dy: 0.012 * i * (i % 2 ? 1 : -1), rotation: 0 }));
    poses[0] = { scale: 1, dx: 0, dy: 0, rotation: 0 };
    const path = cameraPath(poses.map((p) => shot(p)));
    path.forEach((got, i) => expect(Math.abs(got.dy - poses[i].dy)).toBeLessThan(0.006));
  });
});

test("a cutout held still over a background that shakes is two layers", () => {
  // The subject: the picture's left 45% stays put while the rest slides.
  const layered = (dx: number) => {
    const still = shot({ scale: 1, dx: 0, dy: 0, rotation: 0 });
    const moved = shot({ scale: 1, dx, dy: 0, rotation: 0 });
    const data = moved.data.slice();
    for (let y = 0; y < still.height; y++)
      for (let x = 0; x < Math.round(still.width * 0.45); x++) data[y * still.width + x] = still.data[y * still.width + x];
    return { ...moved, data };
  };
  const path = cameraPath([layered(0), layered(0.03), layered(0.06), layered(0.03)]);
  const moving = path.slice(1).map((p) => {
    // Whichever layer is the camera, the other carries the shake.
    const shift = Math.abs(p.dx) > 0.01 ? p.dx : p.second?.dx;
    return Math.round((shift ?? 0) * 100) / 100;
  });
  expect(moving).toEqual([0.03, 0.06, 0.03]);
  expect(path.slice(1).every((p) => p.second)).toBe(true);
});

describe("holdsStill", () => {
  // A beat zoom: out to 1.08 and back, twice.
  const pulse = [1, 1.04, 1.08, 1.04, 1, 1.04, 1.08, 1.04, 1].map((scale) => ({ scale, dx: 0, dy: 0, rotation: 0 }));

  test("a frozen frame pulsed on the beat holds still", () => {
    const frames = pulse.map((p) => shot(p));
    expect(holdsStill(frames, cameraPath(frames))).toBe(true);
  });

  test("a live picture under the same pulse has moved on when the camera comes back", () => {
    const frames = pulse.map((p, i) => shot(p, i + 1));
    expect(holdsStill(frames, cameraPath(frames))).toBe(false);
  });

  test("a steady push never comes back, so it cannot tell", () => {
    const frames = [1, 1.02, 1.04, 1.06].map((scale) => shot({ scale, dx: 0, dy: 0, rotation: 0 }));
    expect(holdsStill(frames, cameraPath(frames))).toBeNull();
  });
});
