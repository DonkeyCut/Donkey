"use client";

import { useState } from "react";
import {
  Captions,
  ChevronDown,
  Film,
  Image as ImageIcon,
  Layers,
  MoreHorizontal,
  Music,
  Pencil,
  Plus,
  Trash2,
  Type,
} from "lucide-react";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import {
  clearAssetDrag,
  setCardDragImage,
  setTemplateDragData,
  type TemplateDrag,
} from "@/cut/lib/assetDrag";
import { MEDIA_CORS } from "@/cut/lib/mediaCors";
import { refFromTemplate, useAssetDrop, type AssetRef } from "@/cut/lib/assetRef";
import { useRefCopy } from "@/cut/lib/refCopy";
import { cardIconButton } from "@/cut/components/iconButton";
import { formatTime } from "@/cut/lib/time";
import { EFFECT_LABELS, retimeOf, type SpeedNode } from "@donkeycut/effects-kit";
import { SHAPE_LABELS } from "@/cut/lib/types";
import type { LibraryTemplate, TemplateMedia } from "@/cut/lib/types";
import { cn } from "@/lib/utils";

/** A template row card: name and parts, a "…" menu (Rename / extras / Delete)
 * and an optional "+" action, both revealed on hover. Rename swaps the name
 * into an inline input. With `drag` set the card drags like any other
 * item — onto the timeline, or onto the Media/Library rail tiles. Clicking the
 * card expands it to preview what's inside: each clip, sound, and title, plus
 * a caption count. Hovering a video/image row floats a live preview (video
 * plays muted); hovering a sound row plays it aloud with a small equalizer in
 * place of the row icon. */
export function TemplateCard({
  template: t,
  mediaSrc,
  drag,
  onAdd,
  addTitle,
  onRename,
  onDelete,
  onRefDrop,
  onDragStartExtra,
  extraMenu,
  selectId,
  selected = false,
}: {
  template: LibraryTemplate;
  /** Resolve a template media file to a playable URL (project or library). */
  mediaSrc: (fileName: string) => string;
  /** The payload this card drags; omit to make it undraggable. */
  drag?: TemplateDrag;
  /** The "+" action; omit to drop the button (e.g. no open project). */
  onAdd?: () => void;
  addTitle?: string;
  /** Rename and delete; omit both on a shelf that can't be written to right
   * now — the card keeps its preview and drops the menu. */
  onRename?: (name: string) => void;
  onDelete?: () => void;
  /** When set, the card accepts media drops (cards and timeline clips) —
   * filter by `ref.scope` and append the item to the template. */
  onRefDrop?: (ref: AssetRef) => void;
  /** Extra drag payload (e.g. a folder-move id) set alongside the template drag. */
  onDragStartExtra?: (e: React.DragEvent) => void;
  /** Extra menu items rendered between Rename and Delete. */
  extraMenu?: React.ReactNode;
  /** Marks the card as sweepable by a marquee under this id, so a template
   * files into folders in the same selection as the media around it. */
  selectId?: string;
  selected?: boolean;
}) {
  const refDrop = useAssetDrop((r) => onRefDrop?.(r));
  // ⌘C over the card copies its mention token, so a saved arrangement can be
  // named in a prompt the same way a clip or an effect is.
  const copyRef = useRefCopy(() => [refFromTemplate(t)]);
  const [renaming, setRenaming] = useState(false);
  const [draft, setDraft] = useState("");
  const [expanded, setExpanded] = useState(false);
  const [preview, setPreview] = useState<{
    media: TemplateMedia;
    top: number;
    left: number;
  } | null>(null);
  // Hovered audio row: plays aloud with the row's icon swapped for a small
  // equalizer — sound needs no floating preview.
  const [audioRow, setAudioRow] = useState<number | null>(null);

  const itemCount =
    t.layers.length + t.audio.length + t.texts.length + t.cues.length;

  // The contents, one row per item, in save order: clips and stills, sounds,
  // titles, then a caption count.
  const speedLen = (x: { in: number; out: number; speed?: number; speedCurve?: SpeedNode[]; reverse?: boolean }) =>
    retimeOf(x).len;
  const parts: {
    icon: typeof Film;
    label: string;
    time?: number;
    media?: TemplateMedia;
  }[] = [
    ...t.layers.map((l) => ({
      icon: t.media[l.media]?.type === "image" ? ImageIcon : Film,
      label: t.media[l.media]?.name ?? "Media",
      time: speedLen(l),
      media: t.media[l.media],
    })),
    ...t.audio.map((a) => ({
      icon: Music,
      label: t.media[a.media]?.name ?? "Audio",
      time: speedLen(a),
      media: t.media[a.media],
    })),
    ...t.texts.map((o) => ({
      icon: Type,
      label:
        o.kind === "shape"
          ? SHAPE_LABELS[o.shape]
          : o.kind === "sticker"
            ? "Sticker"
            : o.kind === "effect"
              ? EFFECT_LABELS[o.effect]
              : o.text || "Title",
      time: o.end - o.start,
    })),
    ...(t.cues.length
      ? [
          {
            icon: Captions,
            label: `${t.cues.length} caption${t.cues.length === 1 ? "" : "s"}`,
          },
        ]
      : []),
  ];

  return (
    <div
      ref={(el) => {
        if (onRefDrop) refDrop.attachTarget(el);
        copyRef(el);
      }}
      {...(onRefDrop ? refDrop.targetProps : {})}
      data-sel-id={selectId}
      className={cn(
        "group flex flex-col rounded-lg border bg-background px-2.5 py-1.5",
        selected ? "border-[#0a84ff] ring-2 ring-[#0a84ff]" : "border-border",
        drag ? "cursor-grab active:cursor-grabbing" : "cursor-pointer",
        onRefDrop && refDrop.active && "border-primary bg-primary/10",
      )}
      draggable={!!drag}
      onDragStart={(e) => {
        if (!drag) return;
        setTemplateDragData(e, drag);
        onDragStartExtra?.(e);
        setCardDragImage(e, e.currentTarget);
      }}
      onDragEnd={clearAssetDrag}
      onClick={(e) => {
        // Buttons and the rename input own their clicks; the card body toggles.
        if ((e.target as HTMLElement).closest("button,input")) return;
        setExpanded((v) => !v);
      }}
    >
      <div className="flex items-center gap-2">
        <Layers className="size-3.5 shrink-0 text-violet-500" />
        <div className="min-w-0 flex-1">
          {renaming ? (
            <Input
              autoFocus
              value={draft}
              className="h-6 w-full text-[12px]"
              onChange={(e) => setDraft(e.target.value)}
              onBlur={() => setRenaming(false)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && draft.trim()) {
                  onRename?.(draft.trim());
                  setRenaming(false);
                } else if (e.key === "Escape") setRenaming(false);
              }}
            />
          ) : (
            <div className="truncate text-[12px] font-medium">{t.name}</div>
          )}
          <div className="flex items-center gap-0.5 text-[10.5px] text-muted-foreground">
            {formatTime(t.duration)} · {itemCount} item
            {itemCount === 1 ? "" : "s"}
            <ChevronDown
              className={cn(
                "size-3 transition-transform",
                expanded && "rotate-180",
              )}
            />
          </div>
        </div>
        <div className="flex shrink-0 items-center gap-1">
          {onAdd && (
            <button
              title={addTitle}
              className="grid size-6 shrink-0 place-items-center rounded-full bg-primary text-primary-foreground opacity-0 hover:brightness-110 group-hover:opacity-100"
              onClick={onAdd}
            >
              <Plus className="size-3.5" />
            </button>
          )}
          {(onRename || onDelete) && (
            <DropdownMenu>
              <DropdownMenuTrigger
                render={
                  <button
                    title="Template options"
                    className={cn(
                      cardIconButton,
                      "opacity-0 group-hover:opacity-100 data-[state=open]:opacity-100",
                    )}
                  />
                }
              >
                <MoreHorizontal className="size-3.5" />
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end" className="min-w-40">
                {onRename && (
                  <DropdownMenuItem
                    onClick={() => {
                      setDraft(t.name);
                      setRenaming(true);
                    }}
                  >
                    <Pencil /> Rename
                  </DropdownMenuItem>
                )}
                {extraMenu}
                {onDelete && (
                  <>
                    <DropdownMenuSeparator />
                    <DropdownMenuItem variant="destructive" onClick={onDelete}>
                      <Trash2 /> Delete
                    </DropdownMenuItem>
                  </>
                )}
              </DropdownMenuContent>
            </DropdownMenu>
          )}
        </div>
      </div>
      {expanded && parts.length > 0 && (
        <div className="mt-1.5 flex flex-col gap-1 border-t border-border pt-1.5">
          {parts.map(({ icon: Icon, label, time, media }, i) => (
            <div
              key={i}
              className={cn(
                "-mx-1 flex min-w-0 shrink-0 items-center gap-1.5 rounded-md px-1 py-0.5 text-[11px] text-muted-foreground",
                media && "hover:bg-muted/60 hover:text-foreground",
              )}
              onMouseEnter={(e) => {
                if (!media) return;
                if (media.type === "audio") {
                  setAudioRow(i);
                  return;
                }
                const r = e.currentTarget.getBoundingClientRect();
                setPreview({
                  media,
                  top: Math.max(
                    8,
                    Math.min(r.top - 8, window.innerHeight - 160),
                  ),
                  left: Math.min(r.right + 10, window.innerWidth - 200),
                });
              }}
              onMouseLeave={() => {
                setPreview(null);
                setAudioRow((v) => (v === i ? null : v));
              }}
            >
              {audioRow === i && media ? (
                <span className="flex size-3 shrink-0 items-center justify-center gap-[1.5px] text-[#0F6E56]">
                  {[0, 1, 2].map((b) => (
                    <span
                      key={b}
                      className="tpl-eq-bar w-[2px] rounded-full bg-current"
                      style={{ animationDelay: `${b * 0.13}s` }}
                    />
                  ))}
                  <audio src={mediaSrc(media.fileName)} autoPlay />
                  <style>{`@keyframes tpl-eq{0%,100%{height:25%}50%{height:85%}}.tpl-eq-bar{height:30%;animation:tpl-eq .8s ease-in-out infinite}`}</style>
                </span>
              ) : (
                <Icon className="size-3 shrink-0" />
              )}
              <span className="min-w-0 flex-1 truncate">{label}</span>
              {time != null && (
                <span className="shrink-0 font-mono text-[10px] tabular-nums">
                  {formatTime(time)}
                </span>
              )}
            </div>
          ))}
        </div>
      )}
      {preview && (
        <div
          className="pointer-events-none fixed z-50"
          style={{ top: preview.top, left: preview.left }}
        >
          {preview.media.type === "video" ? (
            <video
              crossOrigin={MEDIA_CORS}
              src={mediaSrc(preview.media.fileName)}
              autoPlay
              muted
              loop
              playsInline
              className="w-44 rounded-lg border border-border bg-black shadow-lg"
            />
          ) : (
            // eslint-disable-next-line @next/next/no-img-element -- engine media file, not Next-optimizable
            <img
              crossOrigin={MEDIA_CORS}
              src={mediaSrc(preview.media.fileName)}
              alt={preview.media.name}
              className="w-44 rounded-lg border border-border shadow-lg"
            />
          )}
        </div>
      )}
    </div>
  );
}
