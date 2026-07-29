// A confetti burst for the credits slide, drawn on a canvas the slide owns.
// Small enough to keep in the app rather than take a dependency for one moment
// of the product.

const COLORS = ["#ec7868", "#f2b544", "#4f9d69", "#0f0e0d", "#ffffff"];
const GRAVITY = 0.12;
const DRAG = 0.995;

type Piece = {
  x: number;
  y: number;
  vx: number;
  vy: number;
  w: number;
  h: number;
  rotation: number;
  spin: number;
  color: string;
  life: number;
};

/** Fire one burst from the canvas's upper middle. Returns a stop function for
 * the caller's cleanup; a burst also stops on its own once every piece has
 * fallen past the bottom. No-op under prefers-reduced-motion, where a screenful
 * of moving paper is the last thing anyone wants. */
export function burstConfetti(canvas: HTMLCanvasElement, count = 130): () => void {
  if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
    return () => {};
  }
  const context = canvas.getContext("2d");
  if (!context) return () => {};

  const { width, height } = canvas.getBoundingClientRect();
  const ratio = window.devicePixelRatio || 1;
  canvas.width = Math.round(width * ratio);
  canvas.height = Math.round(height * ratio);
  context.scale(ratio, ratio);

  const originX = width / 2;
  const originY = height * 0.38;
  const pieces: Piece[] = Array.from({ length: count }, (_, i) => {
    // Spread the launch angles evenly and jitter each one, so the burst reads
    // as a ring rather than a stripe.
    const angle = (i / count) * Math.PI * 2 + Math.random() * 0.4;
    const speed = 3 + Math.random() * 5;
    return {
      x: originX,
      y: originY,
      vx: Math.cos(angle) * speed,
      vy: Math.sin(angle) * speed - 3,
      w: 5 + Math.random() * 5,
      h: 8 + Math.random() * 6,
      rotation: Math.random() * Math.PI,
      spin: (Math.random() - 0.5) * 0.3,
      color: COLORS[i % COLORS.length],
      life: 0,
    };
  });

  let frame = 0;
  let previous = performance.now();

  const draw = (now: number) => {
    // Step in 60fps units so the burst runs at the same speed on any display.
    const step = Math.min(32, now - previous) / 16.67;
    previous = now;
    context.clearRect(0, 0, width, height);

    let alive = 0;
    for (const piece of pieces) {
      piece.vx *= DRAG;
      piece.vy = piece.vy * DRAG + GRAVITY * step;
      piece.x += piece.vx * step;
      piece.y += piece.vy * step;
      piece.rotation += piece.spin * step;
      piece.life += step;
      if (piece.y - piece.h > height) continue;
      alive += 1;

      context.save();
      context.translate(piece.x, piece.y);
      context.rotate(piece.rotation);
      context.globalAlpha = Math.max(0, 1 - piece.life / 220);
      context.fillStyle = piece.color;
      context.fillRect(-piece.w / 2, -piece.h / 2, piece.w, piece.h);
      context.restore();
    }

    if (alive > 0) frame = requestAnimationFrame(draw);
  };

  frame = requestAnimationFrame(draw);
  return () => cancelAnimationFrame(frame);
}
