"use client";

import type { AssetRef } from "./assetRef";
import { refToInlineImage } from "./refMedia";
import { useEditor } from "./store";
import { formatTime } from "./time";

// The chat composer registers itself here so surfaces outside the AI panel —
// the timeline's "Add video frame to chat" — can land a ref among the open
// thread's attachments and aim the hand-off animation at the composer box.

interface ChatIntake {
  el: HTMLElement;
  add: (ref: AssetRef) => void;
  /** Signal that a grab is in flight, so the composer opens its chip row
   * early — rising in anticipation to catch the frame before it lands. */
  expect?: (incoming: boolean) => void;
  /** Whether the composer takes another grabbed frame. At the render models'
   * reference capacity it declines — surfacing why in its own notice tab —
   * and the grab ends before any capture or flight. */
  acceptFrame?: () => boolean;
  /** Say why a grab ended with nothing, in the composer's notice tab. */
  notice?: (message: string) => void;
}

let intake: ChatIntake | null = null;

/** Mount the open chat composer as the intake; returns the unregister. */
export function registerChatIntake(entry: ChatIntake): () => void {
  intake = entry;
  return () => {
    if (intake === entry) intake = null;
  };
}

/** The composer once it exists. Opening the AI panel mounts it a beat later,
 * so a grab waits briefly; a read-only share never mounts one and times out. */
function waitForIntake(timeoutMs = 1500): Promise<ChatIntake | null> {
  return new Promise((resolve) => {
    const t0 = performance.now();
    const check = () => {
      if (intake) return resolve(intake);
      if (performance.now() - t0 > timeoutMs) return resolve(null);
      requestAnimationFrame(check);
    };
    check();
  });
}

/** Where the flight starts: the grab point and the clip box's vertical
 * extent, viewport coordinates. */
export interface FrameGrabOrigin {
  x: number;
  top: number;
  height: number;
}

const FLY_MS = 520;
// The chip the frame settles into: RefChips' size-14 thumb, sitting inside
// the composer box's padding.
const CHIP = 56;
const CHIP_INSET = 10;
// RefChips' gap-2, between chips and between wrapped rows.
const CHIP_GAP = 8;

/** Where the incoming chip will mount, in the coordinates the composer will
 * occupy once its anticipation growth (the row opening for this very grab)
 * has finished — the box is bottom-anchored, so growing raises its top edge.
 * Measured before the chip mounts, so the flight ends exactly where the list
 * is about to grow: after the last chip in its row, or — when the row is
 * full — at the head of the wrapped row, which lands where the last row
 * stood once the box has risen by one row. The first chip's slot is the
 * opened row's padding corner, one row above today's top edge. */
function nextChipSlot(box: DOMRect, composer: HTMLElement): { left: number; top: number } {
  const chips = composer.querySelectorAll(".ref-chip");
  const last = chips[chips.length - 1]?.getBoundingClientRect();
  if (!last) return { left: box.left + CHIP_INSET, top: box.top - CHIP };
  if (last.right + CHIP_GAP + CHIP > box.right - CHIP_INSET) {
    return { left: box.left + CHIP_INSET, top: last.top };
  }
  return { left: last.right + CHIP_GAP, top: last.top };
}

/** Land the frame `ref` pins among the chat composer's attachments, flying it
 * from the timeline into the composer on the way. Each grab delivers its own
 * image attachment — the captured frame riding inline, named by its video and
 * timestamp — so several frames of the same video sit side by side as chips.
 * Opens the AI panel when it is closed. */
export async function sendFrameToChat(ref: AssetRef, from: FrameGrabOrigin): Promise<void> {
  const s = useEditor.getState();
  if (!s.aiOpen) s.setAiOpen(true);
  const target = await waitForIntake();
  if (!target) return;
  if (target.acceptFrame && !target.acceptFrame()) return;
  // Capture before the flight so it shows the exact frame it delivers.
  const frame = await refToInlineImage(ref).catch(() => null);
  if (!frame) {
    // The clip itself is a heavier, different thing than the moment that was
    // asked for, so nothing is attached — the grab says why and ends.
    target.notice?.(`Couldn’t read a frame from “${ref.name}”.`);
    return;
  }
  const frameRef: AssetRef = {
    scope: "file",
    id: crypto.randomUUID().slice(0, 8),
    name: `${ref.name} @ ${formatTime(ref.t ?? 0)}`,
    kind: "image",
    url: `data:${frame.mimeType};base64,${frame.data}`,
  };

  const img = new Image();
  img.src = `data:${frame.mimeType};base64,${frame.data}`;
  await img.decode().catch(() => {});
  const aspect =
    img.naturalWidth > 0 && img.naturalHeight > 0 ? img.naturalWidth / img.naturalHeight : 16 / 9;

  const h0 = from.height;
  const w0 = h0 * aspect;
  // Measure before the row starts opening, then tell the composer a frame is
  // inbound: it rises to present the slot while the frame is still flying.
  const box = target.el.getBoundingClientRect();
  const slot = nextChipSlot(box, target.el);
  target.expect?.(true);
  const fly = document.createElement("div");
  Object.assign(fly.style, {
    position: "fixed",
    left: `${from.x - w0 / 2}px`,
    top: `${from.top}px`,
    width: `${w0}px`,
    height: `${h0}px`,
    zIndex: "100",
    pointerEvents: "none",
    overflow: "hidden",
    borderRadius: "8px",
    boxShadow: "0 12px 32px rgba(0,0,0,0.35)",
    background: "#000",
  });
  Object.assign(img.style, {
    display: "block",
    width: "100%",
    height: "100%",
    objectFit: "cover",
  });
  fly.appendChild(img);
  document.body.appendChild(fly);

  const flight = fly.animate(
    [
      {
        left: `${from.x - w0 / 2}px`,
        top: `${from.top}px`,
        width: `${w0}px`,
        height: `${h0}px`,
        borderRadius: "8px",
      },
      {
        left: `${slot.left}px`,
        top: `${slot.top}px`,
        width: `${CHIP}px`,
        height: `${CHIP}px`,
        borderRadius: "10px",
      },
    ],
    { duration: FLY_MS, easing: "cubic-bezier(0.32, 0.72, 0, 1)", fill: "forwards" }
  );
  await flight.finished.catch(() => {});
  // The chip mounts under the settled thumb, then the thumb fades off it.
  target.add(frameRef);
  target.expect?.(false);
  const fade = fly.animate([{ opacity: 1 }, { opacity: 0 }], {
    duration: 160,
    easing: "ease-out",
    fill: "forwards",
  });
  await fade.finished.catch(() => {});
  fly.remove();
}
