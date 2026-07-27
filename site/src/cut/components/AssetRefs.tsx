"use client";

import { useEffect, useLayoutEffect, useMemo, useRef, useState, type RefObject } from "react";
import { Check, Copy, FileText, X } from "lucide-react";
import {
  highlightMentions,
  mentionToken,
  refToken,
  type AssetRef,
} from "@/cut/lib/assetRef";
import { MEDIA_CORS } from "@/cut/lib/mediaCors";
import { useRefFor, useRefCandidates } from "@/cut/lib/assetRef";
import { useInView } from "@/cut/hooks/useInView";
import { revealRef } from "@/cut/lib/refReveal";
import { formatTime } from "@/cut/lib/time";
import { useEditor } from "@/cut/lib/store";
import { AudioPillSurface } from "@/cut/components/AudioPanel";
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
  return (
    <div
      ref={thumbRef}
      className={cn(
        "relative shrink-0 overflow-hidden rounded-lg border border-border bg-muted",
        className
      )}
    >
      {item.kind === "video" ? (
        <video crossOrigin={MEDIA_CORS}
          src={seen ? `${item.url}#t=0.1` : undefined}
          preload="metadata"
          muted
          playsInline
          className="size-full object-cover"
        />
      ) : item.kind === "image" ? (
        seen ? (
          // eslint-disable-next-line @next/next/no-img-element -- refs point at engine/static files, not Next-optimizable images
          <img crossOrigin={MEDIA_CORS} src={item.url} alt={item.name} loading="lazy" className="size-full object-cover" />
        ) : null
      ) : item.kind === "text" ? (
        <div className="grid size-full place-items-center bg-gradient-to-br from-slate-100 to-slate-50 text-slate-500">
          <FileText className="size-4.5" />
        </div>
      ) : (
        <AudioPillSurface peaks={peaks} className="size-full rounded-none" />
      )}
      {item.duration !== undefined && item.kind !== "image" && (
        <span className="absolute right-1 bottom-1 rounded-[5px] bg-black/65 px-1 py-px font-mono text-[8.5px] text-white tabular-nums">
          {formatTime(item.duration)}
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

/** Hover peek: a larger look at the ref, floated above the anchor. */
function RefPeek({ item, side = "top" }: { item: AssetRef; side?: "top" | "bottom" }) {
  return (
    <div
      className={cn(
        "ref-peek pointer-events-none absolute left-0 z-50 w-44 overflow-hidden rounded-xl shadow-xl",
        side === "top" ? "bottom-full mb-1.5" : "top-full mt-1.5"
      )}
    >
      {item.kind === "video" ? (
        <PeekVideo item={item} />
      ) : (
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
      <video crossOrigin={MEDIA_CORS} ref={videoRef} src={item.url} loop playsInline className="size-full object-cover" />
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
 * the thumb reveals the original asset. */
export function RefChips({
  refs,
  onRemove,
  className,
  peekSide = "top",
  thumbClassName = "size-14",
}: {
  refs: AssetRef[];
  onRemove: (ref: AssetRef) => void;
  className?: string;
  /** Open peeks downward when the chips sit near the top of their panel. */
  peekSide?: "top" | "bottom";
  /** Thumbnail size, e.g. "size-12" for a compact in-input composer. */
  thumbClassName?: string;
}) {
  const candidates = useRefCandidates();
  if (refs.length === 0) return null;
  return (
    <div className={cn("flex flex-wrap gap-2", className)}>
      {refs.map((r) => {
        // Handles are session-derived; show the live one, not a stored copy.
        const handle =
          candidates.find((c) => c.scope === r.scope && c.id === r.id)?.handle ?? r.handle;
        return (
          <RefChip
            key={`${r.scope}:${r.id}`}
            item={{ ...r, handle }}
            onRemove={onRemove}
            peekSide={peekSide}
            thumbClassName={thumbClassName}
          />
        );
      })}
    </div>
  );
}

function RefChip({
  item,
  onRemove,
  peekSide,
  thumbClassName,
}: {
  item: AssetRef;
  onRemove: (ref: AssetRef) => void;
  peekSide: "top" | "bottom";
  thumbClassName: string;
}) {
  const [peek, setPeek] = useState(false);
  return (
    <div
      className="ref-chip relative"
      onMouseEnter={() => setPeek(true)}
      onMouseLeave={() => setPeek(false)}
    >
      <button
        type="button"
        title={`${item.name} — click to show`}
        className="block text-left"
        onClick={() => revealRef(item)}
      >
        {/* Audio stretches to the timeline-pill shape; the chip row wraps, so
            the wide chip stays within the composer. */}
        <RefThumb
          item={item}
          className={item.kind === "audio" ? "h-12 w-44 max-w-full" : thumbClassName}
        />
      </button>
      {item.handle && <RefHandleBadge handle={item.handle} className="absolute bottom-1 left-1" />}
      {peek && <RefPeek item={item} side={peekSide} />}
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
}) {
  const taRef = useRef<HTMLTextAreaElement>(null);
  const backdropRef = useRef<HTMLDivElement>(null);
  const [caret, setCaret] = useState(0);
  const [dismissed, setDismissed] = useState<number | null>(null);
  // The row highlight, remembered with the query it was chosen for — see
  // `sel` below.
  const [selState, setSelState] = useState<{ q?: string; i: number }>({ i: 0 });

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
    <div className="relative min-w-0">
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
      {/* Highlight overlay: a mirror of the text sitting behind the textarea
          that draws a pill behind every resolved @mention. It shares the
          textarea's typography and padding so the pills line up exactly, and
          scrolls in lockstep. */}
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
        {highlightMentions(value, candidates).map((seg, i) =>
          seg.ref ? (
            <span
              key={i}
              className="rounded-[4px] bg-[#0a84ff]/12 shadow-[0_0_0_2px_rgba(10,132,255,0.12)]"
            >
              {seg.text}
            </span>
          ) : (
            <span key={i}>{seg.text}</span>
          )
        )}
      </div>
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
        onKeyDown={(e) => {
          e.stopPropagation();
          if (open) {
            if (e.key === "ArrowDown" || e.key === "ArrowUp") {
              e.preventDefault();
              setSel((selIndex + (e.key === "ArrowDown" ? 1 : matches.length - 1)) % matches.length);
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
    </div>
  );
}
