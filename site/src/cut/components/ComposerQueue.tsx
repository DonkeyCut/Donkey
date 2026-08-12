"use client";

import { useEffect, useRef, useState } from "react";
import {
  Check,
  ChevronDown,
  GripVertical,
  Loader2,
  Pause,
  Pencil,
  Play,
  Trash2,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { ScrollArea } from "@/components/ui/scroll-area";
import { RefThumb } from "./AssetRefs";
import type { AssetRef } from "@/cut/lib/assetRef";

/** Small icon control on a tray row or the tray header. */
const queueIconButton =
  "grid size-6 shrink-0 place-items-center rounded-md text-muted-foreground transition-colors hover:bg-muted-foreground/20 hover:text-foreground";

/** A message waiting its turn while the assistant works. Attachments are
 * captured at enqueue time, so mentions and chips ride exactly as typed.
 * Running and done rows exist only while an open edit freezes the view —
 * they render crossed out there; outside a freeze they leave the tray. */
export interface QueuedMessage {
  id: string;
  text: string;
  attachments: AssetRef[];
  status: "queued" | "running" | "done";
}

/** The queue tray: a folder tab on top of the composer holding the messages
 * waiting for the running turn to settle. Rows can be reordered by drag,
 * rewritten in place, or removed; the header pauses and resumes dispatch and
 * collapses the list. While a row is being edited the visible list freezes:
 * the other rows keep draining, and each one that dispatches stays in place —
 * a spinner while its turn runs, crossed out once it settles — so the editor
 * never shifts under the cursor. Mounted only while the queue has items. */
export function ComposerQueue({
  items,
  paused,
  busy,
  editingId,
  onEditingChange,
  onCommitEdit,
  onRemove,
  onReorder,
  onTogglePaused,
}: {
  items: QueuedMessage[];
  paused: boolean;
  /** Whether a turn is streaming right now. A running row spins only while
   * its turn is live; once the turn settles it reads as done, even before
   * the next dispatch rewrites its stored status. */
  busy: boolean;
  editingId: string | null;
  onEditingChange: (id: string | null) => void;
  onCommitEdit: (id: string, text: string) => void;
  onRemove: (id: string) => void;
  onReorder: (from: number, to: number) => void;
  onTogglePaused: () => void;
}) {
  const [open, setOpen] = useState(true);
  const dragFrom = useRef<number | null>(null);
  const [dragOver, setDragOver] = useState<number | null>(null);
  const frozen = editingId !== null;
  const waiting = items.filter((m) => m.status === "queued");
  // Rows carry their index in the full queue so a reorder maps back to it.
  const rows = items
    .map((item, index) => ({ item, index }))
    .filter(({ item }) => frozen || item.status === "queued");
  // The wrapper owns the list height: the rows' measured height capped at
  // 38vh, animated to zero on collapse, clipped while it moves. The scroll
  // area fills the wrapper and floats the slim scrollbar over the rows once
  // the cap bites.
  const listRef = useRef<HTMLDivElement>(null);
  const [listH, setListH] = useState(0);
  useEffect(() => {
    const el = listRef.current;
    if (!el) return;
    const measure = () =>
      setListH(Math.min(el.offsetHeight, window.innerHeight * 0.38));
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    window.addEventListener("resize", measure);
    return () => {
      ro.disconnect();
      window.removeEventListener("resize", measure);
    };
  }, []);

  return (
    // The floating stack in the panel tucks the tray's bottom few pixels
    // under the composer box; the bottom padding keeps the rows above that
    // overlap.
    <div className="ai-queue-tray relative mx-1.5 rounded-t-lg border border-b-0 border-border bg-muted pb-1">
      <div
        className={cn(
          "flex items-center gap-2 px-3 py-1",
          open && "border-b border-border",
        )}
      >
        <button
          type="button"
          className="flex min-w-0 flex-1 items-center gap-2 text-left"
          onClick={() => setOpen(!open)}
        >
          <span className="shrink-0 text-[11px] font-medium text-muted-foreground">
            {waiting.length === 1 ? "1 up next" : `${waiting.length} in queue`}
          </span>
          {paused && (
            <span className="truncate text-[11px] text-muted-foreground/60">
              Paused
            </span>
          )}
        </button>
        <div className="flex shrink-0 items-center gap-0.5">
          <button
            type="button"
            className={queueIconButton}
            title={paused ? "Resume the queue" : "Pause the queue"}
            onClick={onTogglePaused}
          >
            {paused ? <Play className="size-3" /> : <Pause className="size-3" />}
          </button>
          <button
            type="button"
            className={queueIconButton}
            title={open ? "Collapse" : "Expand"}
            onClick={() => setOpen(!open)}
          >
            <ChevronDown
              className={cn(
                "size-3 transition-transform duration-200 motion-reduce:transition-none",
                !open && "rotate-180",
              )}
            />
          </button>
        </div>
      </div>

      <div
        className="overflow-hidden transition-[height,opacity] duration-300 ease-[cubic-bezier(0.32,0.72,0,1)] motion-reduce:transition-none"
        style={{ height: open ? listH : 0, opacity: open ? 1 : 0 }}
      >
        <ScrollArea className="h-full">
          <div ref={listRef}>
            {rows.map(({ item: it, index }) => {
              const isEditing = editingId === it.id;
              const shown =
                it.status === "running" && !busy ? "done" : it.status;
              const gone = shown !== "queued";
              const locked = frozen && !isEditing;
              return (
                <div
                  key={it.id}
                  draggable={!frozen}
                  onDragStart={(e) => {
                    dragFrom.current = index;
                    e.dataTransfer.effectAllowed = "move";
                    // The browser snapshots the row on a flat backdrop, which
                    // squares off its corners; hand it a styled clone so the
                    // ghost keeps the rounded row shape.
                    const el = e.currentTarget;
                    const rect = el.getBoundingClientRect();
                    const ghost = el.cloneNode(true) as HTMLElement;
                    // The row hugs the tray edge-to-edge; the detached ghost
                    // gets its rounding back.
                    ghost.className = cn(
                      el.className,
                      "fixed overflow-hidden rounded-lg bg-muted shadow-md",
                    );
                    ghost.style.width = `${rect.width}px`;
                    ghost.style.top = "-1000px";
                    ghost.style.left = "-1000px";
                    document.body.appendChild(ghost);
                    e.dataTransfer.setDragImage(
                      ghost,
                      e.clientX - rect.left,
                      e.clientY - rect.top,
                    );
                    setTimeout(() => ghost.remove(), 0);
                  }}
                  onDragOver={(e) => {
                    e.preventDefault();
                    setDragOver(index);
                  }}
                  onDrop={(e) => {
                    e.preventDefault();
                    if (dragFrom.current !== null && dragFrom.current !== index)
                      onReorder(dragFrom.current, index);
                    dragFrom.current = null;
                    setDragOver(null);
                  }}
                  onDragEnd={() => {
                    dragFrom.current = null;
                    setDragOver(null);
                  }}
                  className={cn(
                    "group flex items-start gap-1.5 px-2.5 py-1.5 transition-colors duration-100 motion-reduce:transition-none",
                    dragOver === index
                      ? "bg-muted-foreground/20"
                      : !isEditing &&
                          !locked &&
                          !gone &&
                          "hover:bg-muted-foreground/10",
                  )}
                >
                  {!isEditing && (
                    <span className="mt-0.5 -ml-0.5 shrink-0">
                      {shown === "running" ? (
                        <Loader2 className="size-3.5 animate-spin text-muted-foreground/60" />
                      ) : shown === "done" ? (
                        <Check className="size-3.5 text-muted-foreground/60" />
                      ) : (
                        <GripVertical className="size-3.5 cursor-grab text-muted-foreground/60" />
                      )}
                    </span>
                  )}
                  <div className="min-w-0 flex-1">
                    {isEditing ? (
                      <QueueEditBox
                        initial={it.text}
                        onCancel={() => onEditingChange(null)}
                        onSave={(v) => {
                          onCommitEdit(it.id, v);
                          onEditingChange(null);
                        }}
                      />
                    ) : (
                      <>
                        <div
                          className={cn(
                            "text-xs leading-snug break-words",
                            locked || gone
                              ? "text-muted-foreground/60"
                              : "text-foreground",
                            gone && "line-through decoration-muted-foreground/40",
                          )}
                        >
                          {it.text}
                        </div>
                        {it.attachments.length > 0 && (
                          <div
                            className={cn(
                              "mt-1 flex flex-wrap gap-1",
                              gone && "opacity-50",
                            )}
                          >
                            {it.attachments.map((a) => (
                              <RefThumb
                                key={`${a.scope}:${a.id}`}
                                item={a}
                                className={
                                  a.kind === "audio" ? "h-8 w-14" : "size-8"
                                }
                              />
                            ))}
                          </div>
                        )}
                      </>
                    )}
                  </div>
                  {!isEditing && !locked && !gone && (
                    <div className="flex shrink-0 items-center gap-0.5 opacity-0 transition-opacity group-focus-within:opacity-100 group-hover:opacity-100 motion-reduce:transition-none">
                      <button
                        type="button"
                        className={queueIconButton}
                        title="Edit this message"
                        onClick={() => onEditingChange(it.id)}
                      >
                        <Pencil className="size-3" />
                      </button>
                      <button
                        type="button"
                        className={queueIconButton}
                        title="Remove from the queue"
                        onClick={() => onRemove(it.id)}
                      >
                        <Trash2 className="size-3" />
                      </button>
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        </ScrollArea>
      </div>
    </div>
  );
}

function QueueEditBox({
  initial,
  onCancel,
  onSave,
}: {
  initial: string;
  onCancel: () => void;
  onSave: (text: string) => void;
}) {
  const [value, setValue] = useState(initial);
  const ref = useRef<HTMLTextAreaElement>(null);
  useEffect(() => {
    const el = ref.current;
    if (el) {
      el.focus();
      el.setSelectionRange(el.value.length, el.value.length);
    }
  }, []);
  return (
    <div className="py-0.5">
      <textarea
        ref={ref}
        value={value}
        onChange={(e) => setValue(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter" && !e.shiftKey) {
            e.preventDefault();
            onSave(value);
          }
          if (e.key === "Escape") onCancel();
        }}
        rows={2}
        className="w-full resize-none rounded-lg border border-input bg-background px-2.5 py-2 text-xs leading-relaxed text-foreground outline-none focus:border-ring"
      />
      <div className="mt-1.5 flex items-center gap-1.5">
        <button
          type="button"
          className="inline-flex h-6 items-center gap-1 rounded-md bg-primary px-2 text-[11px] font-medium text-primary-foreground transition-colors hover:bg-primary/85"
          onClick={() => onSave(value)}
        >
          <Check className="size-3" /> Save
        </button>
        <button
          type="button"
          className="h-6 rounded-md px-2 text-[11px] text-muted-foreground transition-colors hover:bg-muted-foreground/10"
          onClick={onCancel}
        >
          Cancel
        </button>
      </div>
    </div>
  );
}
