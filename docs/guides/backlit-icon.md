# Backlit Icon

The dark treatment for the donkey mark: the flat SVG appears lit from behind by
three point sources. A duplicate silhouette sitting behind the mark generates
all of the light; the mark on top stays exactly as drawn.

**The one rule:** nothing composites above the icon. The icon renders at its
own fills, with no filters and no tint, as the last layer drawn. If light
appears on top of the mark, the stack is wrong.

## The Layer Stack

Bottom to top, in this order:

```text
1  backdrop   near black
2  bloom      three wide blurred silhouettes
3  halo       three tight blurred silhouettes
4  vignette   radial darkening of the frame
5  the icon   untouched
```

The container supplies the backdrop and vignette; the icon element carries only
the glow layers and the mark.

## Files

The treatment needs both files.

| File | Role |
| --- | --- |
| `donkey-icon.svg` | The mark. Fully opaque, counters filled. The top layer. |
| `donkey-silhouette.svg` | Outer contour only, no counters, `fill="currentColor"`. The glow source. |

The mark cuts its counters — the eye, muzzle, and teeth — out of a single path
by reverse winding. A glow layer built from the mark pours light through those
cutouts and fills the interior with haze. The silhouette file keeps only the
outer contour, so light escapes only past the outline.

The same reasoning makes the icon opaque: a counter plate under the artwork
keeps glow out of the interior even when a source sits directly behind the
muzzle.

## Tokens

Every length is a multiple of the rendered icon size, so the treatment holds
from 16px to print. `s` is the icon size; the mark is 264 × 318.

| Token | Value |
| --- | --- |
| Halo blur | `0.030 × s` |
| Bloom blur | `0.088 × s` |
| Light colour | `#ffffff` |
| Backdrop | `#000000` |
| Counters | `#e9e7e0` |
| Mark | `#051020` |
| Vignette | `rgb(0 0 0 / 0.37)` at the corners, transparent at 25 percent radius |

Three sources, each offset toward where its light sits.

| Source | Offset x | Offset y | Halo opacity | Bloom opacity |
| --- | --- | --- | --- | --- |
| A, left | `-0.0297 × s` | `+0.0043 × s` | 0.80 | 0.192 |
| B, above | `-0.0095 × s` | `-0.0285 × s` | 0.62 | 0.149 |
| C, lower right | `+0.0190 × s` | `+0.0232 × s` | 0.35 | 0.084 |

## Plain CSS

```css
.backlit {
  --s: 32px;
  --halo: calc(var(--s) * 0.030);
  --bloom: calc(var(--s) * 0.088);
  --light: #ffffff;

  position: relative;
  display: inline-block;
  width: var(--s);
  height: calc(var(--s) * 318 / 264); /* mark is 264 x 318 */
  isolation: isolate;
}

.backlit__glow {
  position: absolute;
  inset: 0;
  z-index: 0;
  color: var(--light);
  background: currentColor;
  mask: url("donkey-silhouette.svg") center / contain no-repeat;
  -webkit-mask: url("donkey-silhouette.svg") center / contain no-repeat;
  pointer-events: none;
  will-change: filter;
}

/* halo pass, tight */
.backlit__glow--a { filter: blur(var(--halo)); opacity: 0.80; translate: calc(var(--s) * -0.0297) calc(var(--s) *  0.0043); }
.backlit__glow--b { filter: blur(var(--halo)); opacity: 0.62; translate: calc(var(--s) * -0.0095) calc(var(--s) * -0.0285); }
.backlit__glow--c { filter: blur(var(--halo)); opacity: 0.35; translate: calc(var(--s) *  0.0190) calc(var(--s) *  0.0232); }

/* bloom pass, wide */
.backlit__glow--a-wide { filter: blur(var(--bloom)); opacity: 0.192; translate: calc(var(--s) * -0.0297) calc(var(--s) *  0.0043); }
.backlit__glow--b-wide { filter: blur(var(--bloom)); opacity: 0.149; translate: calc(var(--s) * -0.0095) calc(var(--s) * -0.0285); }
.backlit__glow--c-wide { filter: blur(var(--bloom)); opacity: 0.084; translate: calc(var(--s) *  0.0190) calc(var(--s) *  0.0232); }

.backlit__mark {
  position: relative;
  z-index: 1;
  display: block;
  width: 100%;
  height: 100%;
}
```

```html
<span class="backlit" style="--s: 32px">
  <span class="backlit__glow backlit__glow--a-wide"></span>
  <span class="backlit__glow backlit__glow--b-wide"></span>
  <span class="backlit__glow backlit__glow--c-wide"></span>
  <span class="backlit__glow backlit__glow--a"></span>
  <span class="backlit__glow backlit__glow--b"></span>
  <span class="backlit__glow backlit__glow--c"></span>
  <img class="backlit__mark" src="donkey-icon.svg" alt="Donkey" />
</span>
```

The container it sits in supplies the backdrop and vignette.

```css
.backlit-stage {
  background:
    radial-gradient(circle at 50% 50%, transparent 25%, rgb(0 0 0 / 0.37) 100%),
    #000000;
}
```

## Tailwind

Six absolutely positioned masked spans plus the mark. Arbitrary values carry
the tokens.

```jsx
const GLOW = "absolute inset-0 bg-white pointer-events-none " +
  "[mask:url(/donkey-silhouette.svg)_center/contain_no-repeat] " +
  "[-webkit-mask:url(/donkey-silhouette.svg)_center/contain_no-repeat]";

export function BacklitDonkey({ size = 32 }) {
  const s = (k) => `${(size * k).toFixed(3)}px`;
  const halo = s(0.030), bloom = s(0.088);
  const sources = [
    { x: -0.0297, y:  0.0043, halo: 0.80, bloom: 0.192 },
    { x: -0.0095, y: -0.0285, halo: 0.62, bloom: 0.149 },
    { x:  0.0190, y:  0.0232, halo: 0.35, bloom: 0.084 },
  ];

  return (
    <span
      className="relative inline-block isolate"
      style={{ width: size, height: (size * 318) / 264 }}
    >
      {sources.map((src, i) => (
        <span key={`w${i}`} className={GLOW}
          style={{ filter: `blur(${bloom})`, opacity: src.bloom,
                   translate: `${s(src.x)} ${s(src.y)}` }} />
      ))}
      {sources.map((src, i) => (
        <span key={`h${i}`} className={GLOW}
          style={{ filter: `blur(${halo})`, opacity: src.halo,
                   translate: `${s(src.x)} ${s(src.y)}` }} />
      ))}
      <img src="/donkey-icon.svg" alt="Donkey"
           className="relative block h-full w-full" />
    </span>
  );
}
```

Stage wrapper.

```jsx
<div className="bg-black [background-image:radial-gradient(circle_at_50%_50%,transparent_25%,rgb(0_0_0/0.37)_100%)]">
```

## Rules

Each of these is a failure mode already hit and fixed. Keep them.

1. **The mark keeps its own colour.** No overlays, no filters on the icon
   element, no light colour mixed in. The icon renders at its own fill and is
   the last thing drawn.
2. **Backdrop and vignette belong to the container.** They stop at the mark. A
   vignette applied over the whole composite muddies the artwork.
3. **Blur radii scale with icon size.** A fixed pixel blur looks right at one
   size and turns to mush at 24px. Express every blur as a multiple of the
   rendered size.
4. **The counter colour is its own token.** Changing the backdrop leaves the
   eye and teeth untouched; they follow the counter token.
5. **Light travels a bounded distance from the outline.** Brightness falls off
   with distance from the contour, which is what makes the composite read as a
   backlight.
6. **Watch the antialiased edge.** A near-white plate under an antialiased mark
   produces a bright hairline around the whole outline. Keep the counter plate
   inside the artwork edge.

## Other Marks

Replace both SVGs: the silhouette is the outer contour with counters removed,
and the icon is opaque. Every token is relative to size and every offset is
relative to the mark centre, so the rest carries over unchanged.

## Scale Guidance

| Context | `--s` | Note |
| --- | --- | --- |
| Toolbar | 16 to 24px | Drop bloom opacity by half; the wide pass mostly disappears anyway |
| Sidebar or nav | 32 to 48px | Values as specified |
| Hero or splash | 128px and up | Consider raising bloom; the frame can carry more spread |
