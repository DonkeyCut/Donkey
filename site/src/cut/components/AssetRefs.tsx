"use client";

import { useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode, type RefObject } from "react";
import { Check, Copy, FileText, X } from "lucide-react";
import {
  highlightMentions,
  liveRefUrl,
  mentionToken,
  refToken,
  sameRef,
  splitMentions,
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
import { entityGlyph } from "@/cut/components/entityIcons";
import { parseTimeInput } from "@/cut/components/ScrubValue";
import { ValueSlider } from "@/cut/components/ValueSlider";
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
          {item.preview ? (
            // eslint-disable-next-line @next/next/no-img-element -- refs point at engine/static files, not Next-optimizable images
            <img
              src={item.preview}
              alt={item.name}
              loading="lazy"
              className="size-full object-contain p-1"
            />
          ) : (
            (entityGlyph(item, "size-4.5") ?? <FileText className="size-4.5" />)
          )}
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
  /** Style for a dark bubble — the user message. */
  onDark?: boolean;
  peekSide?: "top" | "bottom";
}) {
  const [peek, setPeek] = useState(false);
  // Entity refs have no media to peek at and no card to jump to — the pill
  // itself, icon plus name, is the whole story.
  if (item.scope === "entity") {
    return (
      <span
        className={cn(
          "ref-token inline-flex items-center gap-1 rounded-md px-1 align-middle font-mono text-[11px]",
          onDark ? "bg-white/15 text-[#8ec7ff]" : "bg-[#0a84ff]/10 text-[#0a84ff]"
        )}
      >
        {item.preview ? (
          // eslint-disable-next-line @next/next/no-img-element -- refs point at engine/static files, not Next-optimizable images
          <img src={item.preview} alt="" className="size-3 shrink-0 object-contain" />
        ) : (
          entityGlyph(item, cn("size-2.5 shrink-0", item.keyTrack === "mask" && "text-[#ff9f0a]"))
        )}
        {item.name}
      </span>
    );
  }
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

/** Message text with its resolved `@` mentions drawn as token chips. One
 * renderer for every place a written message is shown — the chat thread and
 * the queue tray above the composer — so a message reads the same before it
 * is sent, while it waits, and after it lands. Tokens resolve against the
 * message's own attachments first (they hold what was meant when it was
 * written), then the live candidates. */
export function MentionedText({
  text,
  attachments = [],
  onDark,
}: {
  text: string;
  attachments?: AssetRef[];
  /** Style for a dark bubble — the user message. */
  onDark?: boolean;
}) {
  const candidates = useRefCandidates();
  const parts = useMemo(
    () => splitMentions(text, [...attachments, ...candidates]),
    [text, attachments, candidates]
  );
  return (
    <>
      {parts.map((p, i) =>
        typeof p === "string" ? (
          <span key={i}>{p}</span>
        ) : (
          <RefTokenChip key={i} item={p} onDark={onDark} />
        )
      )}
    </>
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
      {onUpdate || item.scope === "entity" ? (
        <div title={item.scope === "entity" ? item.name : undefined}>
          <RefThumb
            item={item}
            className={item.kind === "audio" ? "h-12 w-44 max-w-full" : thumbClassName}
          />
        </div>
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
        // Entity refs have nothing more to show than the chip itself.
        hover && item.scope !== "entity" && <RefPeek item={item} side={peekSide} />
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

/** The timeline selection the last pill click made, so dismissing the pick in
 * chat can take it back without touching a selection made elsewhere. */
let lastReveal: { kind: string; id: string } | null = null;

/** Select the entity a pill points at, so the timeline highlights and reveals
 * it. The ref id carries the timeline identity (`overlay:<id>`, `cue:<id>`,
 * `key:clip:<id>:pose:<n>`, …). */
function revealEntity(ref: AssetRef) {
  const [kind, a, b, c, d] = ref.id.split(":");
  const st = useEditor.getState();
  if (kind === "overlay" || kind === "cue" || kind === "transition") {
    st.select({ kind, id: a });
    lastReveal = { kind, id: a };
    return;
  }
  if (kind !== "key") return;
  const ownerKind = a === "clip" ? "clip" : "overlay";
  const owner =
    ownerKind === "clip"
      ? st.clips.find((x) => x.id === b)
      : st.overlays.find((x) => x.id === b);
  const track = c === "mask" ? "mask" : "pose";
  const keys = track === "pose" ? owner?.kf : owner?.mask?.kf;
  const key = keys ? [...keys].sort((x, y) => x.t - y.t)[Number(d)] : undefined;
  st.select({ kind: ownerKind, id: b });
  lastReveal = { kind: ownerKind, id: b };
  if (key)
    useEditor.setState({ selectedKey: { kind: ownerKind, id: b, t: key.t, track } });
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
      <ValueSlider
        label="Pinned moment"
        sliderClassName="min-w-0 flex-1"
        valueClassName="shrink-0 text-muted-foreground"
        value={t}
        min={lo}
        max={Math.max(hi, lo + 0.1)}
        step={0.1}
        keyStep={1}
        format={formatTime}
        parse={parseTimeInput}
        onDraft={apply}
        onCommit={apply}
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
  mention = true,
}: {
  name: string;
  className?: string;
  /** On a dark/filled surface (audio cards): white badge and copied text. */
  dark?: boolean;
  /** Whether a prompt is within reach. A mention token is only worth copying
   * where it can be pasted, so surfaces outside the editor — the library and
   * projects homes — show the name and nothing more. */
  mention?: boolean;
}) {
  const [copied, copy] = useCopied();
  const ref = useRefFor(name);
  const token = ref ? refToken(ref) : mentionToken(name);
  if (!mention) {
    return <span className={cn("block min-w-0 truncate text-left", className)}>{name}</span>;
  }
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

/** One resolved mention in the composer mirror. Entity pills paint over the
 * raw token with the entity's icon (or the sticker's own art) and name — the
 * token glyphs underneath keep their exact layout, so the textarea's caret
 * math never drifts. The overlay steps aside while the caret sits inside the
 * token (the user is editing it) and when the token wraps across lines (an
 * inline overlay can only cover one line box). */
function MentionPill({
  item,
  text,
  editing,
  selected,
  caretAtStart,
  bleedL,
  bleedR,
  pinnable,
  onPin,
  onSelectToken,
}: {
  item: AssetRef;
  text: string;
  editing: boolean;
  /** The selection covers this token — the pill is picked whole. */
  selected: boolean;
  /** A collapsed caret sits right before the token — the cover would hide
   * the real one, so the pill paints its own on top. */
  caretAtStart: boolean;
  bleedL: boolean;
  bleedR: boolean;
  pinnable: boolean;
  onPin: (ref: AssetRef, el: HTMLElement) => void;
  /** Select the whole token in the textarea. */
  onSelectToken: () => void;
}) {
  const spanRef = useRef<HTMLSpanElement>(null);
  const coverRef = useRef<HTMLSpanElement>(null);
  const [wrapped, setWrapped] = useState(false);
  // A cover that needs more room than the raw token has would truncate the
  // name; once it measures too wide for this token text it stays raw.
  const [clippedFor, setClippedFor] = useState<string | null>(null);
  // Measured every render: wrapping depends on everything before the token.
  useLayoutEffect(() => {
    setWrapped((spanRef.current?.getClientRects().length ?? 1) > 1);
    const cover = coverRef.current;
    if (cover && cover.scrollWidth > cover.clientWidth + 1) setClippedFor(text);
  });
  const glyph = entityGlyph(
    item,
    cn(
      "relative size-[0.9em] shrink-0",
      // Mask keyframes carry the timeline's amber; everything else the pill blue.
      item.keyTrack === "mask" ? "text-[#ff9f0a]" : "text-[#0a84ff]"
    )
  );
  const rich =
    item.scope === "entity" &&
    !editing &&
    !wrapped &&
    clippedFor !== text &&
    !!(glyph || item.preview);
  // Entity pills act as one object: a click selects the whole token, so the
  // caret never lands inside and typing replaces it in one stroke.
  const atomic = item.scope === "entity" && !pinnable;
  return (
    <span
      ref={spanRef}
      className={cn(
        // Padding cancelled by negative margin: the background gains side
        // padding to match the font's own vertical inset while every glyph
        // stays exactly where the textarea draws it.
        "rounded-[4px] bg-[#0a84ff]/12",
        rich && "relative",
        // The cover spans the padding box, so a bleed under it would paint
        // over the character typed right after the token. The cover draws its
        // own pill, sized to the token alone; padding and margin cancel each
        // other, so dropping both leaves the text metrics untouched.
        bleedL && !rich && "pl-[0.15em] -ml-[0.15em]",
        bleedR && !rich && "pr-[0.15em] -mr-[0.15em]",
        pinnable && "pointer-events-auto cursor-pointer hover:bg-[#0a84ff]/25",
        atomic && "pointer-events-auto cursor-default"
      )}
      title={pinnable ? `${item.name} — click to pin the moment` : undefined}
      // mousedown, not click: preventDefault keeps focus in the textarea.
      onMouseDown={
        pinnable
          ? (e) => {
              e.preventDefault();
              onPin(item, e.currentTarget);
            }
          : atomic
            ? (e) => {
                e.preventDefault();
                onSelectToken();
                revealEntity(item);
              }
            : undefined
      }
    >
      {text}
      {rich && (
        // Opaque cover over the raw token: the composer's background, the
        // pill tint on top, then icon + name. It stretches a little past the
        // inline box vertically so the art keeps a visible margin.
        <span
          ref={coverRef}
          className={cn(
            "pointer-events-none absolute inset-x-0 -inset-y-[0.1em] flex items-center overflow-hidden rounded-[4px] bg-background whitespace-nowrap",
            // Sticker art bleeds to the pill's own edges; icons sit inset.
            item.preview ? "gap-[0.25em]" : "gap-[0.3em] pl-[0.25em]"
          )}
        >
          <span className="absolute inset-0 rounded-[4px] bg-[#0a84ff]/12" />
          {item.preview ? (
            // eslint-disable-next-line @next/next/no-img-element -- refs point at engine/static files, not Next-optimizable images
            <img
              src={item.preview}
              alt=""
              className="relative h-full w-[1.05em] shrink-0 rounded-l-[4px] object-cover"
            />
          ) : (
            glyph
          )}
          <span className="relative text-foreground">{item.name}</span>
          {/* Picked whole: the same pill with a blue ring, painted last so it
              rides over the full-bleed art. */}
          {selected && (
            <span className="absolute inset-0 rounded-[4px] ring-[1.5px] ring-[#0a84ff] ring-inset" />
          )}
        </span>
      )}
      {rich && caretAtStart && (
        // The mirror's stand-in for the real caret, which blinks in the
        // textarea underneath the cover's left edge. Mounting on caret
        // arrival restarts the animation, matching the browser's own reset.
        <span className="pointer-events-none absolute -inset-y-[0.1em] -left-px w-[1.5px] animate-[mention-caret_1.1s_steps(1)_infinite] bg-foreground" />
      )}
    </span>
  );
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
  // Selection end and focus, so a pill knows when the user is editing inside
  // its token and should see the raw text.
  const [selEnd, setSelEnd] = useState(0);
  const [focused, setFocused] = useState(false);
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

  // Mirror segments with their character offsets, so a pill can tell when
  // the caret sits inside its token.
  const mirrorSegs = useMemo(
    () =>
      highlightMentions(value, candidates).reduce<
        { text: string; ref: AssetRef | null; start: number }[]
      >((acc, seg) => {
        const prev = acc[acc.length - 1];
        acc.push({ ...seg, start: prev ? prev.start + prev.text.length : 0 });
        return acc;
      }, []),
    [value, candidates]
  );

  // A pill cover is one box, so its token must move between lines whole —
  // wrapped mid-token it falls back to raw text. Resolved entity tokens ride
  // no-break spaces (pasted or typed ones get rewritten here); the swap keeps
  // the length, so every caret offset survives and the write settles.
  useEffect(() => {
    let next = value;
    for (const m of mirrorSegs) {
      if (m.ref?.scope !== "entity" || !m.text.includes(" ")) continue;
      next =
        next.slice(0, m.start) +
        m.text.replace(/ /g, " ") +
        next.slice(m.start + m.text.length);
    }
    if (next === value) return;
    const el = taRef.current;
    const s = el?.selectionStart ?? null;
    const e = el?.selectionEnd ?? null;
    onChange(next);
    if (el && s !== null)
      requestAnimationFrame(() => el.setSelectionRange(s, e ?? s));
  }, [mirrorSegs, value, onChange]);

  const mention = useMemo(() => mentionAtCaret(value, caret), [value, caret]);
  const matches = useMemo(() => {
    if (!mention || dismissed === mention.start) return [];
    // A caret strictly inside an intact, resolved token is a click on the
    // pill — the mention is complete, and offering lookalike suggestions for
    // its half-read query would misdirect it.
    const inResolved = mirrorSegs.some(
      (seg) => seg.ref && caret > seg.start && caret < seg.start + seg.text.length
    );
    if (inResolved) return [];
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
    // Entity refs (keyframes, transitions, cues, elements) reach a prompt by
    // ⌘C copy-paste; the popover offers media and clips, so a long subtitle
    // track never floods the list.
    return candidates
      .filter((c) => c.scope !== "entity")
      .map((c) => ({ c, r: rank(c) }))
      .filter((x) => x.r < 3)
      .sort((a, b) => a.r - b.r)
      .slice(0, 8)
      .map((x) => x.c);
  }, [mention, dismissed, candidates, mirrorSegs, caret]);
  const open = matches.length > 0;
  // Each keystroke re-ranks the list, so a highlight chosen under a previous
  // query derives back to the best (first) match instead of holding a stale
  // arrow/hover position.
  const sel = selState.q === mention?.query ? selState.i : 0;
  const setSel = (i: number) => setSelState({ q: mention?.query, i });
  const selIndex = Math.min(sel, matches.length - 1);

  const syncCaret = () => {
    const el = taRef.current;
    if (!el) return;
    let start = el.selectionStart ?? 0;
    let end = el.selectionEnd ?? start;
    // Entity tokens are atomic: the caret never rests inside one. A collapsed
    // caret arriving inside (arrow keys) picks the whole token; a range
    // endpoint inside grows to the token edge. The write below echoes another
    // select event, which re-enters here and settles as a no-op.
    const inside = (pos: number) =>
      mirrorSegs.find(
        (m) => m.ref?.scope === "entity" && pos > m.start && pos < m.start + m.text.length
      );
    if (start === end) {
      const seg = inside(start);
      if (seg) {
        start = seg.start;
        end = seg.start + seg.text.length;
      }
    } else {
      start = inside(start)?.start ?? start;
      const seg = inside(end);
      if (seg) end = seg.start + seg.text.length;
    }
    if (start !== el.selectionStart || end !== el.selectionEnd) el.setSelectionRange(start, end);
    setCaret(start);
    setSelEnd(end);
  };

  /** Select a whole token: clicking an entity pill picks it as one object. */
  const selectToken = (start: number, len: number) => {
    const el = taRef.current;
    if (!el) return;
    el.focus();
    el.setSelectionRange(start, start + len);
    setCaret(start);
    setSelEnd(start + len);
  };

  /** Some entity pill is picked whole right now. */
  const anyPicked =
    focused &&
    selEnd > caret &&
    mirrorSegs.some(
      (m) => m.ref?.scope === "entity" && caret === m.start && selEnd === m.start + m.text.length
    );

  // Dismissing a pick inside the composer (arrowing away, typing over it,
  // clicking elsewhere in the text) takes back the timeline selection that
  // pick made. A blur keeps it — leaving for the timeline or another panel
  // is working with the selection, and clearing it there would fight the
  // click that took focus.
  useEffect(() => {
    if (anyPicked || !focused || !lastReveal) return;
    const st = useEditor.getState();
    const cur = st.selection;
    if (cur && cur.kind === lastReveal.kind && cur.id === lastReveal.id) st.select(null);
    lastReveal = null;
  }, [anyPicked, focused]);

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
        // While a pill is picked whole, the pill's ring is the selection
        // highlight — the browser's own selection paint would spill out
        // around the cover as a bare blue rectangle.
        className={cn(className, "relative block bg-transparent", anyPicked && "selection:bg-transparent")}
        rows={rows}
        placeholder={placeholder}
        value={value}
        onChange={(e) => {
          setDismissed(null);
          onChange(e.target.value);
          setCaret(e.target.selectionStart ?? 0);
          setSelEnd(e.target.selectionEnd ?? e.target.selectionStart ?? 0);
        }}
        onFocus={() => setFocused(true)}
        onBlur={() => setFocused(false)}
        onScroll={(e) => {
          const bd = backdropRef.current;
          if (bd) {
            bd.scrollTop = e.currentTarget.scrollTop;
            bd.scrollLeft = e.currentTarget.scrollLeft;
          }
        }}
        onSelect={syncCaret}
        onPaste={(e) => {
          if (onPasteFiles) {
            const files = Array.from(e.clipboardData.items)
              .filter((item) => item.kind === "file")
              .map((item) => item.getAsFile())
              .filter((f): f is File => f !== null);
            if (files.length > 0) {
              e.preventDefault();
              onPasteFiles(files);
              return;
            }
          }
          // A token pasted flush against a neighbor never resolves — the
          // quote swallows the boundary. Restore the missing space on
          // whichever side needs one.
          const text = e.clipboardData.getData("text/plain");
          if (!text) return;
          const el = e.currentTarget;
          const s = el.selectionStart ?? 0;
          const sEnd = el.selectionEnd ?? s;
          const needL = text.startsWith("@") && /\S/.test(value[s - 1] ?? "");
          const needR = /\S$/.test(text) && (value[sEnd] ?? "") === "@";
          if (!needL && !needR) return;
          e.preventDefault();
          setDismissed(null);
          const insert = (needL ? " " : "") + text + (needR ? " " : "");
          onChange(value.slice(0, s) + insert + value.slice(sEnd));
          const nc = s + (needL ? 1 : 0) + text.length;
          requestAnimationFrame(() => {
            const ta = taRef.current;
            if (!ta) return;
            ta.setSelectionRange(nc, nc);
            setCaret(nc);
            setSelEnd(nc);
          });
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
          // Deleting into an entity token picks it whole first; the next
          // press removes it in one stroke, so a half-eaten token never
          // degenerates into raw text.
          if (
            (e.key === "Backspace" || e.key === "Delete") &&
            !e.metaKey &&
            !e.altKey &&
            !e.ctrlKey
          ) {
            const el = e.currentTarget;
            const pos = el.selectionStart ?? 0;
            if (pos === (el.selectionEnd ?? pos)) {
              const seg = mirrorSegs.find(
                (m) =>
                  m.ref?.scope === "entity" &&
                  pos === (e.key === "Backspace" ? m.start + m.text.length : m.start)
              );
              if (seg) {
                e.preventDefault();
                selectToken(seg.start, seg.text.length);
                return;
              }
            }
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
        {mirrorSegs.map((seg, i) => {
          if (!seg.ref) return <span key={i}>{seg.text}</span>;
          // A side facing another pill across a single space keeps its bleed
          // off — two bleeds would swallow the only gap between the pills.
          const facing = (gap: number, other: number) =>
            !!mirrorSegs[gap] &&
            !mirrorSegs[gap].ref &&
            /^\s$/.test(mirrorSegs[gap].text) &&
            !!mirrorSegs[other]?.ref;
          const end = seg.start + seg.text.length;
          // Raw text shows only while a range endpoint rests strictly inside
          // the token; entity endpoints normalize to the token edges, so an
          // entity pill stays covered through any selection sweep (⌘A too).
          const editing =
            focused &&
            ((caret > seg.start && caret < end) || (selEnd > seg.start && selEnd < end));
          // The selection covers the whole token — a pill click or a sweep
          // across it — and the pill wears its ring.
          const covered = focused && selEnd > caret && caret <= seg.start && selEnd >= end;
          return (
            <MentionPill
              key={i}
              item={seg.ref}
              text={seg.text}
              editing={editing}
              selected={covered}
              caretAtStart={focused && caret === seg.start && selEnd === seg.start}
              bleedL={!facing(i - 1, i - 2)}
              bleedR={!facing(i + 1, i + 2)}
              pinnable={
                !!onUpsertRef && (seg.ref.kind === "video" || seg.ref.kind === "audio")
              }
              onPin={openPin}
              onSelectToken={() => selectToken(seg.start, seg.text.length)}
            />
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
