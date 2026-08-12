"use client";

import { useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode, type RefObject } from "react";
import { Check, Copy, FileText, X } from "lucide-react";
import {
  highlightMentions,
  liveRefUrl,
  mentionToken,
  refToken,
  sameRef,
  type AssetRef,
} from "@/cut/lib/assetRef";
import { MEDIA_CORS } from "@/cut/lib/mediaCors";
import { useRefFor, useRefCandidates } from "@/cut/lib/assetRef";
import { useInView } from "@/cut/hooks/useInView";
import { revealRef } from "@/cut/lib/refReveal";
import { formatTime } from "@/cut/lib/time";
import { clipLen, getClipSpans, useEditor } from "@/cut/lib/store";
import { playheadAt } from "@/cut/lib/playhead";
import { AudioPillSurface } from "@/cut/components/AudioPanel";
import { ScrubValue, parseTimeInput } from "@/cut/components/ScrubValue";
import { Slider } from "@/components/ui/slider";
import { cn } from "@/lib/utils";

// Shared UI for asset references: the preview thumbnail, attachment chips,
// copy-the-reference affordances, interactive `@v2` token chips (hover peek,
// click to reveal the original asset), and a textarea with `@` autocomplete.
// Every surface that takes references (AI chat, image/video creators)
// composes these.

/** Media preview for a ref: video poster frame, image, a glyph for text
 * files, or the timeline-style emerald waveform pill for audio. Audio reads
 * best wide — give it a wide box where the layout has room. */
export function RefThumb({ item, className }: { item: AssetRef; className?: string }) {
  // Project audio has real waveform peaks in the store; the pill draws a
  // stand-in for everything else.
  const peaks = useEditor((s) =>
    item.kind === "audio" && item.scope === "project"
      ? s.assets.find((a) => a.id === item.id)?.peaks
      : undefined
  );
  // Chips render for every past message; the media loads only once on screen.
  const [thumbRef, seen] = useInView<HTMLDivElement>();
  // A pinned moment is what the ref means now — show that frame. The source
  // rides the pin only on first load; afterwards the pin seeks the same
  // element in place, which keeps the last frame up until the new one decodes
  // (a fresh #t= src blanks the thumb white on every scrub step).
  const videoEl = useRef<HTMLVideoElement>(null);
  const [firstT] = useState(item.t ?? 0.1);
  useEffect(() => {
    const el = videoEl.current;
    if (el && item.t !== undefined && el.readyState >= HTMLMediaElement.HAVE_METADATA) {
      el.currentTime = item.t;
    }
  }, [item.t]);
  return (
    <div
      ref={thumbRef}
      className={cn(
        "relative shrink-0 overflow-hidden rounded-lg border border-border bg-muted",
        className
      )}
    >
      {item.kind === "video" ? (
        <video
          crossOrigin={MEDIA_CORS}
          ref={videoEl}
          src={seen ? `${item.url}#t=${firstT}` : undefined}
          preload="metadata"
          muted
          playsInline
          className="size-full object-cover"
          onLoadedMetadata={(e) => {
            if (item.t !== undefined) e.currentTarget.currentTime = item.t;
          }}
        />
      ) : item.kind === "image" ? (
        seen ? (
          // eslint-disable-next-line @next/next/no-img-element -- refs point at engine/static files, not Next-optimizable images
          <img
            crossOrigin={MEDIA_CORS}
            src={item.url}
            alt={item.name}
            loading="lazy"
            className="size-full object-cover"
          />
        ) : null
      ) : item.kind === "text" ? (
        <div className="grid size-full place-items-center bg-gradient-to-br from-slate-100 to-slate-50 text-slate-500">
          <FileText className="size-4.5" />
        </div>
      ) : (
        <AudioPillSurface peaks={peaks} className="size-full rounded-none" />
      )}
      {/* One badge: the pinned moment when the user chose one, the length otherwise. */}
      {(item.t !== undefined || (item.duration !== undefined && item.kind !== "image")) && (
        <span className="absolute right-1 bottom-1 rounded-[5px] bg-black/65 px-1 py-px font-mono text-[8.5px] text-white tabular-nums">
          {formatTime(item.t ?? item.duration!)}
        </span>
      )}
    </div>
  );
}

/** The `v2` badge shown on chips, cards, and the mention menu (on light UI). */
export function RefHandleBadge({ handle, className }: { handle: string; className?: string }) {
  return (
    <span
      className={cn(
        "rounded-[5px] bg-[#0a84ff]/12 px-1 py-px font-mono text-[9px] font-medium text-[#0a84ff]",
        className
      )}
    >
      {handle}
    </span>
  );
}

/** A legible reference-token pill for image tiles: dark so it reads over any
 * image, showing the mention to type (`@i2`, `@nature-dunes`). Caller controls
 * visibility (shown on hover). */
/**
 * A generated asset's @handle on its tile: shown on hover or focus, and a
 * button — clicking it puts the reference on the clipboard, which is how a
 * sticker or a render made earlier gets typed into a prompt somewhere else.
 * The same pill on every generation tab, so the gesture is learned once.
 */
export function CopyHandlePill({
  handle,
  name,
  className,
}: {
  handle?: string;
  name: string;
  className?: string;
}) {
  const [copied, setCopied] = useState(false);
  const token = handle ? `@${handle}` : mentionToken(name);
  return (
    <button
      type="button"
      title="Copy reference"
      aria-label={`Copy reference ${token}`}
      className={cn(
        "absolute top-1 left-1 max-w-[calc(100%-0.5rem)] rounded-[5px] opacity-0 transition-opacity group-hover:opacity-100 focus-visible:opacity-100",
        className
      )}
      onClick={(e) => {
        // The tile under it takes a click as "pick me"; copying is its own act.
        e.stopPropagation();
        void navigator.clipboard
          .writeText(token)
          .then(() => {
            setCopied(true);
            setTimeout(() => setCopied(false), 1200);
          })
          .catch(() => {});
      }}
    >
      <RefHandlePill token={copied ? "Copied" : token} />
    </button>
  );
}

export function RefHandlePill({ token, className }: { token: string; className?: string }) {
  return (
    <span
      className={cn(
        "pointer-events-none max-w-[calc(100%-0.5rem)] truncate rounded-[5px] bg-black/65 px-1.5 py-0.5 font-mono text-[10px] font-medium text-white",
        className
      )}
    >
      {token}
    </span>
  );
}

/** Hover peek: a larger look at the ref, floated beside the anchor. `side` is
 * a preference — on open the peek measures the panel it sits in (nearest
 * clipping ancestor, clamped to the window) and flips below or right-aligns
 * as needed to stay fully visible. */
function RefPeek({ item, side = "top" }: { item: AssetRef; side?: "top" | "bottom" }) {
  const peekEl = useRef<HTMLDivElement>(null);
  const [place, setPlace] = useState({ side, alignRight: false });
  useLayoutEffect(() => {
    const peek = peekEl.current;
    const anchor = peek?.parentElement;
    if (!peek || !anchor) return;
    let clip: HTMLElement | null = anchor.parentElement;
    while (
      clip &&
      getComputedStyle(clip).overflowX === "visible" &&
      getComputedStyle(clip).overflowY === "visible"
    )
      clip = clip.parentElement;
    const bound = (clip ?? document.documentElement).getBoundingClientRect();
    const a = anchor.getBoundingClientRect();
    const top = Math.max(bound.top, 0);
    const bottom = Math.min(bound.bottom, window.innerHeight);
    const right = Math.min(bound.right, window.innerWidth) - 8;
    const left = Math.max(bound.left, 0) + 8;
    const h = peek.offsetHeight + 6;
    const fitsAbove = a.top - top >= h;
    const fitsBelow = bottom - a.bottom >= h;
    setPlace({
      side:
        side === "top" ? (fitsAbove || !fitsBelow ? "top" : "bottom")
        : fitsBelow || !fitsAbove ? "bottom"
        : "top",
      alignRight: a.left + peek.offsetWidth > right && a.right - peek.offsetWidth >= left,
    });
  }, [side]);
  return (
    <div
      ref={peekEl}
      className={cn(
        "ref-peek pointer-events-none absolute z-50 w-44 overflow-hidden rounded-xl shadow-xl",
        place.side === "top" ? "bottom-full mb-1.5" : "top-full mt-1.5",
        place.alignRight ? "right-0" : "left-0"
      )}
    >
      {item.kind === "video" && item.t === undefined ? (
        <PeekVideo item={item} />
      ) : (
        // A pinned video peeks as its pinned frame, still — the pin names one
        // moment, so playing from the top would show everything but it.
        <RefThumb
          item={item}
          className={item.kind === "audio" ? "h-14 w-full" : "aspect-square w-full"}
        />
      )}
    </div>
  );
}

/** A video peek plays the clip for as long as the pointer hovers — with sound,
 * falling back to a silent preview if the browser blocks unmuted autoplay. */
function PeekVideo({ item }: { item: AssetRef }) {
  const videoRef = useRef<HTMLVideoElement>(null);
  useEffect(() => {
    const v = videoRef.current;
    if (!v) return;
    v.muted = false;
    void v.play().catch(() => {
      v.muted = true;
      void v.play().catch(() => {});
    });
  }, []);
  return (
    <div className="relative aspect-square w-full border border-border bg-muted">
      <video
        crossOrigin={MEDIA_CORS}
        ref={videoRef}
        src={item.url}
        loop
        playsInline
        className="size-full object-cover"
      />
      {item.duration !== undefined && (
        <span className="absolute right-1 bottom-1 rounded-[5px] bg-black/65 px-1 py-px font-mono text-[8.5px] text-white tabular-nums">
          {formatTime(item.duration)}
        </span>
      )}
    </div>
  );
}

/**
 * An inline `@v2` reference token: hover peeks at the asset, click jumps back
 * to it (side panel switches to its tab and the card flashes). Rendered inside
 * chat messages wherever a mention resolved.
 */
export function RefTokenChip({
  item,
  onDark,
  peekSide = "top",
}: {
  item: AssetRef;
  /** Style for a dark bubble (the user message) instead of the light page. */
  onDark?: boolean;
  peekSide?: "top" | "bottom";
}) {
  const [peek, setPeek] = useState(false);
  return (
    <span
      className="relative inline-block"
      onMouseEnter={() => setPeek(true)}
      onMouseLeave={() => setPeek(false)}
    >
      <button
        type="button"
        title={`${item.name} — click to show`}
        className={cn(
          "ref-token rounded-md px-1 font-mono text-[11px] transition-colors",
          onDark
            ? "bg-white/15 text-[#8ec7ff] hover:bg-white/25"
            : "bg-[#0a84ff]/10 text-[#0a84ff] hover:bg-[#0a84ff]/20"
        )}
        onClick={() => revealRef(item)}
      >
        @{item.handle ?? item.name}
      </button>
      {peek && <RefPeek item={item} side={peekSide} />}
    </span>
  );
}

/** Removable attachment chips shown above an input — hover peeks, clicking
 * the thumb reveals the original asset. With `onUpdate`, a video or audio
 * chip opens the moment picker on click instead, so the user can pin the
 * exact moment the reference means. */
export function RefChips({
  refs,
  onRemove,
  onUpdate,
  className,
  peekSide = "top",
  thumbClassName = "size-14",
  trailing,
}: {
  refs: AssetRef[];
  onRemove: (ref: AssetRef) => void;
  /** Replace a chip's ref in place (moment picker) — omit for read-only rows. */
  onUpdate?: (ref: AssetRef) => void;
  className?: string;
  /** Open peeks downward when the chips sit near the top of their panel. */
  peekSide?: "top" | "bottom";
  /** Thumbnail size, e.g. "size-12" for a compact in-input composer. */
  thumbClassName?: string;
  /** Extra node laid out in the chip row after the chips — the composer's
   * incoming-frame spacer reserves the next slot there, wrapping to a fresh
   * row exactly when the arriving chip would. */
  trailing?: ReactNode;
}) {
  const candidates = useRefCandidates();
  if (refs.length === 0 && !trailing) return null;
  return (
    <div className={cn("flex flex-wrap gap-2", className)}>
      {refs.map((r) => {
        // Handles are session-derived; show the live one, not a stored copy.
        // The URL follows the live asset too: a chip attached mid-import
        // starts on the file's local object URL and swaps to storage when the
        // upload lands. liveRefUrl, because chat-owned attachments never
        // become candidates.
        const handle =
          candidates.find((c) => c.scope === r.scope && c.id === r.id)?.handle ?? r.handle;
        return (
          <RefChip
            key={`${r.scope}:${r.id}`}
            item={{ ...r, handle, url: liveRefUrl(r.scope, r.id, r.url) }}
            onRemove={onRemove}
            onUpdate={onUpdate}
            peekSide={peekSide}
            thumbClassName={thumbClassName}
          />
        );
      })}
      {trailing}
    </div>
  );
}

/** Moment-card width, shared by the card and the chip's overflow measurement. */
const CARD_W = 224;

/** The one moment card allowed open anywhere — whoever opens next calls the
 * previous owner's dismiss first, so a stuck hold can never strand a card. */
let dismissOpenCard: (() => void) | null = null;

/** Claim the open-card slot while `open`; call inside an effect. */
function claimOpenCard(open: boolean, dismiss: () => void): (() => void) | undefined {
  if (!open) return undefined;
  if (dismissOpenCard && dismissOpenCard !== dismiss) dismissOpenCard();
  dismissOpenCard = dismiss;
  return () => {
    if (dismissOpenCard === dismiss) dismissOpenCard = null;
  };
}

function RefChip({
  item,
  onRemove,
  onUpdate,
  peekSide,
  thumbClassName,
}: {
  item: AssetRef;
  onRemove: (ref: AssetRef) => void;
  onUpdate?: (ref: AssetRef) => void;
  peekSide: "top" | "bottom";
  thumbClassName: string;
}) {
  const [hover, setHover] = useState(false);
  // The moment card must survive interactions that take the pointer or focus
  // off the chip — a slider/hot-text drag (pointer capture) and typing in the
  // timestamp editor — or it would unmount mid-gesture.
  const [held, setHeld] = useState(false);
  const [focused, setFocused] = useState(false);
  useEffect(() => {
    if (!held) return;
    const up = () => setHeld(false);
    window.addEventListener("pointerup", up);
    return () => window.removeEventListener("pointerup", up);
  }, [held]);
  const pinnable = !!onUpdate && (item.kind === "video" || item.kind === "audio");
  const showCard = pinnable && (hover || held || focused);
  useEffect(
    () =>
      claimOpenCard(showCard, () => {
        setHover(false);
        setHeld(false);
        setFocused(false);
      }),
    [showCard]
  );
  // The card opens on the chip's left edge, shifted just enough to stay
  // inside the nearest clipping ancestor (a panel's scroll area cuts off
  // whatever crosses its edges). Measured once as the card opens.
  const chipEl = useRef<HTMLDivElement>(null);
  const [cardDx, setCardDx] = useState(0);
  useEffect(() => {
    if (!showCard) return;
    const el = chipEl.current;
    if (!el) return;
    let clip = el.parentElement;
    while (clip && getComputedStyle(clip).overflowX === "visible") clip = clip.parentElement;
    const bound = (clip ?? document.documentElement).getBoundingClientRect();
    const chip = el.getBoundingClientRect();
    const minLeft = bound.left + 8;
    const maxLeft = Math.max(minLeft, bound.right - 8 - CARD_W);
    setCardDx(Math.min(Math.max(chip.left, minLeft), maxLeft) - chip.left);
  }, [showCard]);
  return (
    <div
      ref={chipEl}
      className="ref-chip relative"
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
    >
      {/* Audio stretches to the timeline-pill shape; the chip row wraps, so
          the wide chip stays within the composer. Composer chips (onUpdate)
          are inert surfaces — hover carries the moment card; click-to-reveal
          belongs to the read-only rows on past messages. */}
      {onUpdate ? (
        <RefThumb
          item={item}
          className={item.kind === "audio" ? "h-12 w-44 max-w-full" : thumbClassName}
        />
      ) : (
        <button
          type="button"
          title={`${item.name} — click to show`}
          className="block text-left"
          onClick={() => revealRef(item)}
        >
          <RefThumb
            item={item}
            className={item.kind === "audio" ? "h-12 w-44 max-w-full" : thumbClassName}
          />
        </button>
      )}
      {item.handle && (
        // The timeline's token look — black pill, white mono @handle — so the
        // chip names itself the way the clip does on the timeline.
        <RefHandlePill
          token={`@${item.handle}`}
          // The pinned-time badge owns the bottom edge; the handle steps up
          // to the top corner so the two never overlap on a small thumb.
          className={cn("absolute left-1", item.t !== undefined ? "top-1" : "bottom-1")}
        />
      )}
      {/* Hover: pinnable chips open the moment card — preview plus controls,
          adjustable in place; everything else peeks. */}
      {showCard && onUpdate ? (
        <div
          onPointerDown={() => setHeld(true)}
          // Hold for the timestamp text editor only. The slider keeps focus
          // after a drag ends — its thumb wraps a hidden range input — so
          // holding for it would pin this card open while the user moves on.
          onFocusCapture={(e) => {
            if (e.target instanceof HTMLInputElement && e.target.type === "text") setFocused(true);
          }}
          onBlurCapture={(e) => {
            if (e.target instanceof HTMLInputElement && e.target.type === "text") setFocused(false);
          }}
        >
          <RefMomentPicker item={item} side={peekSide} offsetX={cardDx} onChange={onUpdate} />
        </div>
      ) : (
        hover && <RefPeek item={item} side={peekSide} />
      )}
      <button
        aria-label={`Remove ${item.name}`}
        title="Remove"
        className="absolute -top-1.5 -right-1.5 grid size-4.5 place-items-center rounded-full bg-neutral-900 text-white shadow-sm transition-colors hover:bg-neutral-700"
        onClick={() => onRemove(item)}
      >
        <X className="size-3" />
      </button>
    </div>
  );
}

/** The playhead's moment on `ref` in source seconds, when the playhead
 * currently sits on that media on the timeline — the clip itself for clip
 * refs, any timeline clip playing the asset for project refs (freeze_frame's
 * playhead→source mapping). Null when the playhead is elsewhere. */
function playheadMoment(ref: AssetRef): number | null {
  if (ref.scope !== "clip" && ref.scope !== "project") return null;
  const s = useEditor.getState();
  const now = playheadAt();
  const sp = getClipSpans(s.clips, s.assets).find(
    (x) =>
      now >= x.start &&
      now < x.start + x.len &&
      (ref.scope === "clip" ? x.clip.id === ref.id : x.asset.id === ref.id)
  );
  if (sp) return sp.clip.in + (now - sp.start);
  const a = s.audioClips.find(
    (x) =>
      now >= x.start &&
      now < x.start + clipLen(x) &&
      (ref.scope === "clip" ? x.id === ref.id : x.assetId === ref.id)
  );
  return a ? a.in + (now - a.start) : null;
}

/** The scrubbable range behind a ref's pin: a clip ref covers its trimmed
 * [in, out] of the source (its pin is source seconds), anything else the whole
 * media. `dur` supplies a probed duration when the ref doesn't know its own. */
function momentBounds(ref: AssetRef, dur?: number): { lo: number; hi: number } {
  if (ref.scope === "clip") {
    const s = useEditor.getState();
    const c = s.clips.find((x) => x.id === ref.id);
    if (c) return { lo: c.in, hi: c.out };
    const a = s.audioClips.find((x) => x.id === ref.id);
    if (a) return { lo: a.in, hi: a.out };
  }
  return { lo: 0, hi: dur ?? ref.duration ?? 0 };
}

/** The pin's controls — the zoom-style slider and the hot-text timestamp
 * (drag to nudge, click to type) — shared by the chip's inline row and the
 * picker popover. Controlled by the ref itself: every change lands through
 * `onChange`. */
function MomentControls({
  item,
  dur,
  onChange,
  className,
}: {
  item: AssetRef;
  dur?: number;
  onChange: (ref: AssetRef) => void;
  className?: string;
}) {
  const { lo, hi } = momentBounds(item, dur);
  const t = item.t ?? lo;
  const apply = (next: number) =>
    onChange({ ...item, t: Math.min(Math.max(lo, next), hi > lo ? hi : next) });
  return (
    <div className={cn("flex items-center gap-2", className)}>
      <div className="min-w-0 flex-1">
        <Slider
          min={lo}
          max={Math.max(hi, lo + 0.1)}
          step={0.1}
          value={t}
          aria-label="Pinned moment"
          onValueChange={(v) => apply(Number(v))}
        />
      </div>
      <ScrubValue
        value={t}
        min={lo}
        max={Math.max(hi, lo + 0.1)}
        step={0.1}
        keyStep={1}
        format={formatTime}
        parse={parseTimeInput}
        onScrub={apply}
        onCommit={apply}
        label="Pinned moment timestamp"
        className="shrink-0 text-muted-foreground"
      />
    </div>
  );
}

/** Pin a moment on a video/audio ref: the preview bleeds to the popover's
 * edges (the video seeking live, or the audio waveform with a playhead), the
 * controls sit padded below. Changes apply as the user scrubs. */
function RefMomentPicker({
  item,
  side,
  offsetX = 0,
  onChange,
  onClose,
}: {
  item: AssetRef;
  side: "top" | "bottom";
  /** Horizontal shift (px) off the anchor's left edge — how a chip keeps the
   * card inside its panel's clipping bounds. */
  offsetX?: number;
  onChange: (ref: AssetRef) => void;
  /** Close on click-away — pass it when the picker opens from a click (a
   * mention pill). A hover-opened card omits it: hover-out closes instead,
   * and a page-covering backdrop would swallow the next click. */
  onClose?: () => void;
}) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const [dur, setDur] = useState(item.duration ?? 0);
  const { lo, hi } = momentBounds(item, dur);
  // When the playhead already sits on this media on the timeline, that moment
  // is almost always the one the user means — the picker opens there and pins
  // it outright. Read once at open.
  // eslint-disable-next-line react-hooks/exhaustive-deps -- open-time read, keyed by identity
  const playheadAt = useMemo(() => playheadMoment(item), [item.scope, item.id]);
  const t = item.t ?? playheadAt ?? lo;
  const peaks = useEditor((s) =>
    item.kind === "audio" && item.scope === "project"
      ? s.assets.find((a) => a.id === item.id)?.peaks
      : undefined
  );

  // Opening on the playhead's moment IS the pick — land it right away so the
  // chip shows its badge without a scrub.
  useEffect(() => {
    if (item.t === undefined && playheadAt !== null)
      onChange({
        ...item,
        t: Math.min(Math.max(lo, playheadAt), hi > lo ? hi : playheadAt),
      });
    // eslint-disable-next-line react-hooks/exhaustive-deps -- open-time seed only
  }, []);

  // The preview tracks the pin wherever it's adjusted from — this popover's
  // controls or the chip's inline row.
  useEffect(() => {
    const el = videoRef.current;
    if (el && Number.isFinite(el.duration)) el.currentTime = Math.min(t, el.duration);
  }, [t]);

  return (
    <>
      {/* Click-away closes; the picker floats above it. */}
      {onClose && <div className="fixed inset-0 z-40" onClick={onClose} />}
      {/* The offset is transparent padding, not margin: it keeps the card
          hover-connected to its chip, so the cursor can cross from thumb to
          controls without the card unmounting under it. */}
      <div
        style={{ left: offsetX }}
        className={cn("absolute z-50", side === "top" ? "bottom-full pb-1.5" : "top-full pt-1.5")}
      >
        <div
          style={{ width: CARD_W }}
          className="overflow-hidden rounded-xl border border-border bg-popover shadow-xl"
        >
          {item.kind === "video" ? (
            <video
              crossOrigin={MEDIA_CORS}
              ref={videoRef}
              src={item.url}
              preload="metadata"
              muted
              playsInline
              className="aspect-video w-full bg-muted object-cover"
              onLoadedMetadata={(e) => {
                const el = e.currentTarget;
                if (!dur && Number.isFinite(el.duration)) setDur(el.duration);
                el.currentTime = Math.min(t, el.duration || t);
              }}
            />
          ) : (
            <div className="relative h-10 w-full overflow-hidden">
              <AudioPillSurface peaks={peaks} className="size-full rounded-none" />
              {hi > lo && (
                <div
                  // The timeline playhead's blue, but with a white keyline —
                  // on the emerald waveform the bare line all but vanishes.
                  className="absolute inset-y-0 w-[2px] bg-[#0a84ff] shadow-[0_0_0_1.5px_rgba(255,255,255,0.95),0_0_8px_rgba(10,132,255,0.6)]"
                  style={{
                    left: `${Math.min(100, Math.max(0, ((t - lo) / (hi - lo)) * 100))}%`,
                  }}
                />
              )}
              {!item.duration && (
                <audio
                  crossOrigin={MEDIA_CORS}
                  src={item.url}
                  preload="metadata"
                  className="hidden"
                  onLoadedMetadata={(e) => {
                    if (Number.isFinite(e.currentTarget.duration)) setDur(e.currentTarget.duration);
                  }}
                />
              )}
            </div>
          )}
          <MomentControls item={item} dur={dur} onChange={onChange} className="p-2" />
        </div>
      </div>
    </>
  );
}

function useCopied(): [boolean, (text: string) => void] {
  const [copied, setCopied] = useState(false);
  const copy = (text: string) => {
    void navigator.clipboard.writeText(text).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    });
  };
  return [copied, copy];
}

/** Hover icon button that copies the asset's reference token (`@v2`, or the
 * `@name` form when it has no short handle). */
export function CopyRefButton({ name, className }: { name: string; className?: string }) {
  const [copied, copy] = useCopied();
  const ref = useRefFor(name);
  const token = ref ? refToken(ref) : mentionToken(name);
  return (
    <span
      role="button"
      aria-label={`Copy reference to ${name}`}
      title={`Copy ${token} to reference in prompts`}
      className={cn(
        "grid size-5 cursor-pointer place-items-center rounded-full bg-black/45 text-white hover:bg-black/65",
        className
      )}
      onClick={(e) => {
        e.stopPropagation();
        e.preventDefault();
        copy(token);
      }}
    >
      {copied ? <Check className="size-3" /> : <Copy className="size-3" />}
    </span>
  );
}

/** A card's name caption with its short handle; clicking copies the reference
 * token, ready to paste into any prompt. */
export function CopyNameLabel({
  name,
  className,
  dark,
}: {
  name: string;
  className?: string;
  /** On a dark/filled surface (audio cards): white badge and copied text. */
  dark?: boolean;
}) {
  const [copied, copy] = useCopied();
  const ref = useRefFor(name);
  const token = ref ? refToken(ref) : mentionToken(name);
  return (
    <button
      type="button"
      title={`Click to copy ${token} — paste it in any prompt to reference this asset`}
      className={cn("flex min-w-0 items-center gap-1 cursor-copy text-left", className)}
      onClick={(e) => {
        e.stopPropagation();
        copy(token);
      }}
    >
      {ref?.handle && (
        <RefHandleBadge
          handle={ref.handle}
          className={cn("shrink-0", dark && "bg-white/25 text-white")}
        />
      )}
      {copied ? (
        <span className={cn("truncate", dark ? "text-white" : "text-emerald-600")}>
          Copied {token}
        </span>
      ) : (
        <span className="truncate">{name}</span>
      )}
    </button>
  );
}

/** The open mention being typed at the caret: token start and query text. */
function mentionAtCaret(value: string, caret: number): { start: number; query: string } | null {
  const before = value.slice(0, caret);
  const at = before.lastIndexOf("@");
  if (at < 0) return null;
  if (at > 0 && !/[\s([]/.test(before[at - 1])) return null;
  let query = before.slice(at + 1);
  if (query.startsWith('"')) query = query.slice(1);
  // A finished quote or a newline means the caret left the mention.
  if (query.includes('"') || query.includes("\n") || query.length > 60) return null;
  return { start: at, query };
}

/**
 * Textarea with `@` autocomplete over the given candidates — matches short
 * handles (`@v2`) and names, and inserts the handle token when there is one.
 * Submit behavior is the caller's: `submitKey` picks plain Enter (chat) or
 * ⌘/Ctrl+Enter (creators).
 */
export function MentionTextarea({
  value,
  onChange,
  candidates,
  onSubmit,
  submitKey = "enter",
  menuSide = "top",
  placeholder,
  className,
  rows,
  autoGrow = false,
  inputRef,
  attachedRefs,
  onUpsertRef,
  onPasteFiles,
  onRemoveLastRef,
}: {
  value: string;
  onChange: (v: string) => void;
  candidates: AssetRef[];
  onSubmit?: () => void;
  submitKey?: "enter" | "mod-enter";
  /** Where the picker opens relative to the textarea. */
  menuSide?: "top" | "bottom";
  placeholder?: string;
  className?: string;
  rows?: number;
  /** Grow the textarea to fit its content as the user types (capped by the
      caller's `max-h-*`). Leave off when the caller wants a fixed or
      manually resizable box. */
  autoGrow?: boolean;
  /** Caller's handle on the underlying textarea (e.g. to restore focus). */
  inputRef?: RefObject<HTMLTextAreaElement | null>;
  /** The composer's already-attached refs — a pill click reads its pinned
   * moment from here so mention and chip stay one ref. */
  attachedRefs?: AssetRef[];
  /** Land a ref (with its pin) among the composer's attachments. Providing it
   * makes video/audio mention pills clickable: the pill opens the moment
   * picker in place, and the pinned ref lands here so it rides at send. */
  onUpsertRef?: (ref: AssetRef) => void;
  /** Take files pasted into the textarea (a screenshot on the clipboard, an
   * image copied off the web) — same handler as the composer's file drop. */
  onPasteFiles?: (files: File[]) => void;
  /** Backspace with the caret at the very start (nothing selected, nothing to
   * delete leftward) removes the newest attachment chip instead. */
  onRemoveLastRef?: () => void;
}) {
  const taRef = useRef<HTMLTextAreaElement>(null);
  const rootRef = useRef<HTMLDivElement>(null);
  const backdropRef = useRef<HTMLDivElement>(null);
  const [caret, setCaret] = useState(0);
  const [dismissed, setDismissed] = useState<number | null>(null);
  /** The open pill picker: the ref it edits and where it anchors, in the
   * container's coordinates (the pill's top and bottom edges). */
  const [pin, setPin] = useState<{
    ref: AssetRef;
    left: number;
    top: number;
    bottom: number;
  } | null>(null);
  // The pill popover competes for the same one-open-card slot as chip cards.
  useEffect(() => claimOpenCard(pin !== null, () => setPin(null)), [pin]);
  // The row highlight, remembered with the query it was chosen for — see
  // `sel` below.
  const [selState, setSelState] = useState<{ q?: string; i: number }>({ i: 0 });

  // Auto-pin on mention add: the moment a video/audio mention resolves in the
  // text while the playhead sits on that media, the pinned chip lands on its
  // own — no picker step. One shot per mention; deleting the token and
  // re-typing it pins again at the playhead's new spot.
  const autoPinned = useRef(new Set<string>());
  useEffect(() => {
    if (!onUpsertRef) return;
    const present = new Set<string>();
    for (const seg of highlightMentions(value, candidates)) {
      const ref = seg.ref;
      if (!ref || (ref.kind !== "video" && ref.kind !== "audio")) continue;
      const key = `${ref.scope}:${ref.id}`;
      present.add(key);
      if (autoPinned.current.has(key)) continue;
      autoPinned.current.add(key);
      const attached = attachedRefs?.find((a) => sameRef(a, ref));
      if (attached?.t !== undefined) continue;
      const at = playheadMoment(ref);
      if (at !== null) onUpsertRef({ ...(attached ?? ref), t: at });
    }
    for (const k of [...autoPinned.current]) if (!present.has(k)) autoPinned.current.delete(k);
  }, [value, candidates, attachedRefs, onUpsertRef]);

  const mention = useMemo(() => mentionAtCaret(value, caret), [value, caret]);
  const matches = useMemo(() => {
    if (!mention || dismissed === mention.start) return [];
    const q = mention.query.toLowerCase();
    // Best match first, not list order: a typed handle prefix ("c" → c1, c2)
    // beats a name prefix, which beats a substring hit anywhere in the name —
    // otherwise short queries drown the handles in incidental name matches.
    // Ranked once per candidate (the list spans the full stock catalogs and
    // this runs per keystroke), then sorted on the cached rank.
    const rank = (c: AssetRef) => {
      if (c.handle?.startsWith(q)) return 0;
      const name = c.name.toLowerCase();
      return name.startsWith(q) ? 1 : name.includes(q) ? 2 : 3;
    };
    return candidates
      .map((c) => ({ c, r: rank(c) }))
      .filter((x) => x.r < 3)
      .sort((a, b) => a.r - b.r)
      .slice(0, 8)
      .map((x) => x.c);
  }, [mention, dismissed, candidates]);
  const open = matches.length > 0;
  // Each keystroke re-ranks the list, so a highlight chosen under a previous
  // query derives back to the best (first) match instead of holding a stale
  // arrow/hover position.
  const sel = selState.q === mention?.query ? selState.i : 0;
  const setSel = (i: number) => setSelState({ q: mention?.query, i });
  const selIndex = Math.min(sel, matches.length - 1);

  const syncCaret = () => {
    const el = taRef.current;
    if (el) setCaret(el.selectionStart ?? 0);
  };

  /** Open the moment picker anchored on a mention pill. The pill spans live
   * in the mirror overlay, so the anchor is measured into the container's
   * coordinates and the picker rendered at the root (the mirror clips). */
  const openPin = (ref: AssetRef, el: HTMLElement) => {
    const root = rootRef.current;
    if (!root) return;
    const r = el.getBoundingClientRect();
    const c = root.getBoundingClientRect();
    const current = attachedRefs?.find((a) => sameRef(a, ref)) ?? ref;
    setPin({
      ref: current,
      // Keep the 224px popover inside the composer.
      left: Math.max(0, Math.min(r.left - c.left, c.width - 228)),
      top: r.top - c.top,
      bottom: r.bottom - c.top,
    });
  };

  const pick = (ref: AssetRef) => {
    if (!mention) return;
    const token = refToken(ref) + " ";
    const next = value.slice(0, mention.start) + token + value.slice(caret);
    const newCaret = mention.start + token.length;
    onChange(next);
    setSel(0);
    requestAnimationFrame(() => {
      const el = taRef.current;
      if (!el) return;
      el.focus();
      el.setSelectionRange(newCaret, newCaret);
      setCaret(newCaret);
    });
  };

  // Auto-grow: reset to natural height, then match the content. The caller's
  // `max-h-*` caps it and the textarea scrolls internally past that point.
  useLayoutEffect(() => {
    if (!autoGrow) return;
    const el = taRef.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${el.scrollHeight}px`;
  }, [autoGrow, value]);

  return (
    <div ref={rootRef} className="relative min-w-0">
      {open && (
        <div
          className={cn(
            "ref-mention-menu absolute inset-x-0 z-30 flex max-h-56 flex-col overflow-y-auto rounded-lg border border-border bg-popover p-1 shadow-lg",
            menuSide === "top" ? "bottom-full mb-1" : "top-full mt-1"
          )}
        >
          {matches.map((c, i) => (
            <button
              key={`${c.scope}:${c.id}`}
              type="button"
              className={cn(
                "flex w-full items-center gap-2 rounded-md px-1.5 py-1 text-left",
                i === selIndex ? "bg-muted" : "hover:bg-muted/60"
              )}
              onMouseEnter={() => setSel(i)}
              // mousedown, not click: keep focus (and the mention state) in the textarea.
              onMouseDown={(e) => {
                e.preventDefault();
                pick(c);
              }}
            >
              <RefThumb item={c} className="size-8" />
              {c.handle && <RefHandleBadge handle={c.handle} className="shrink-0" />}
              <span className="min-w-0 flex-1 truncate text-[11.5px]">{c.name}</span>
            </button>
          ))}
        </div>
      )}
      <textarea
        ref={(el) => {
          taRef.current = el;
          if (inputRef) inputRef.current = el;
        }}
        className={cn(className, "relative block bg-transparent")}
        rows={rows}
        placeholder={placeholder}
        value={value}
        onChange={(e) => {
          setDismissed(null);
          onChange(e.target.value);
          setCaret(e.target.selectionStart ?? 0);
        }}
        onScroll={(e) => {
          const bd = backdropRef.current;
          if (bd) {
            bd.scrollTop = e.currentTarget.scrollTop;
            bd.scrollLeft = e.currentTarget.scrollLeft;
          }
        }}
        onSelect={syncCaret}
        onPaste={(e) => {
          if (!onPasteFiles) return;
          const files = Array.from(e.clipboardData.items)
            .filter((item) => item.kind === "file")
            .map((item) => item.getAsFile())
            .filter((f): f is File => f !== null);
          if (files.length === 0) return;
          e.preventDefault();
          onPasteFiles(files);
        }}
        onKeyDown={(e) => {
          e.stopPropagation();
          if (
            e.key === "Backspace" &&
            onRemoveLastRef &&
            // One deliberate press, one chip. A held Backspace repeats about
            // thirty times a second, so the run that clears a prompt would
            // otherwise carry straight on through the attachments; the
            // word/line deletions do not touch them at all.
            !e.repeat &&
            !e.metaKey &&
            !e.altKey &&
            !e.ctrlKey &&
            e.currentTarget.selectionStart === 0 &&
            e.currentTarget.selectionEnd === 0
          ) {
            e.preventDefault();
            onRemoveLastRef();
            return;
          }
          if (open) {
            if (e.key === "ArrowDown" || e.key === "ArrowUp") {
              e.preventDefault();
              setSel(
                (selIndex + (e.key === "ArrowDown" ? 1 : matches.length - 1)) % matches.length
              );
              return;
            }
            if (e.key === "Enter" || e.key === "Tab") {
              e.preventDefault();
              pick(matches[selIndex]);
              return;
            }
            if (e.key === "Escape") {
              e.preventDefault();
              setDismissed(mention?.start ?? null);
              return;
            }
          }
          if (!onSubmit) return;
          const wantsSubmit =
            submitKey === "enter"
              ? e.key === "Enter" && !e.shiftKey
              : e.key === "Enter" && (e.metaKey || e.ctrlKey);
          if (wantsSubmit) {
            e.preventDefault();
            onSubmit();
          }
        }}
      />
      {/* Highlight overlay: a mirror of the text over the textarea that draws
          a pill on every resolved @mention. It shares the textarea's
          typography and padding so the pills line up exactly, and scrolls in
          lockstep. It ignores the pointer except on pinnable pills, so typing
          and caret clicks land in the textarea while a video/audio pill takes
          the click and opens the moment picker. */}
      <div
        ref={backdropRef}
        aria-hidden
        className={cn(
          className,
          // Keep the border width for identical text metrics, but draw nothing:
          // only the real textarea should paint a box.
          "pointer-events-none absolute inset-0 overflow-hidden border-transparent bg-transparent whitespace-pre-wrap break-words text-transparent"
        )}
      >
        {highlightMentions(value, candidates).map((seg, i, segs) => {
          const pinnable =
            !!onUpsertRef && (seg.ref?.kind === "video" || seg.ref?.kind === "audio");
          // A side facing another pill across a single space keeps its bleed
          // off — two bleeds would swallow the only gap between the pills.
          const facing = (gap: number, other: number) =>
            !!segs[gap] && !segs[gap].ref && /^\s$/.test(segs[gap].text) && !!segs[other]?.ref;
          return seg.ref ? (
            <span
              key={i}
              className={cn(
                // Padding cancelled by negative margin: the background gains
                // side padding to match the font's own vertical inset while
                // every glyph stays exactly where the textarea draws it.
                "rounded-[4px] bg-[#0a84ff]/12",
                !facing(i - 1, i - 2) && "pl-[0.15em] -ml-[0.15em]",
                !facing(i + 1, i + 2) && "pr-[0.15em] -mr-[0.15em]",
                pinnable && "pointer-events-auto cursor-pointer hover:bg-[#0a84ff]/25"
              )}
              title={pinnable ? `${seg.ref.name} — click to pin the moment` : undefined}
              // mousedown, not click: preventDefault keeps focus in the textarea.
              onMouseDown={
                pinnable
                  ? (e) => {
                      e.preventDefault();
                      openPin(seg.ref!, e.currentTarget);
                    }
                  : undefined
              }
            >
              {seg.text}
            </span>
          ) : (
            <span key={i}>{seg.text}</span>
          );
        })}
      </div>
      {pin && onUpsertRef && (
        <div
          className="absolute z-50"
          style={{
            left: pin.left,
            top: menuSide === "top" ? pin.top : pin.bottom,
          }}
        >
          <RefMomentPicker
            item={pin.ref}
            side={menuSide}
            onChange={(r) => {
              setPin((p) => (p ? { ...p, ref: r } : p));
              onUpsertRef(r);
            }}
            onClose={() => setPin(null)}
          />
        </div>
      )}
    </div>
  );
}
