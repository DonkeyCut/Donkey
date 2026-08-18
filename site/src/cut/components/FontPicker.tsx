"use client";

/**
 * The font menu, shared by the title inspector and the caption panel.
 *
 * It lists the base system set, the bundled families, and the account's own
 * fonts off the Library shelf, and it is where a font file gets onto that shelf
 * in the first place: "Upload font" is a row in the menu, and each of the
 * user's own fonts carries the button that takes it off again.
 */

import { Laptop, Loader2, Trash2, Upload } from "lucide-react";
import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectSeparator,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { isFontFile } from "@/cut/lib/media";
import {
  deleteLinkedItem,
  libraryFontId,
  listLibraryFonts,
  expandLinkedFiles,
  linkedAccept,
  onLinkedChanged,
  uploadLibraryFont,
  type LinkedItem,
} from "@/cut/lib/linkedLibrary";
import { useEditor } from "@/cut/lib/store";
import { allFonts, fontStack, onFontsChanged } from "@/cut/lib/types";
import { cn } from "@/lib/utils";

/** Picking this row opens the file dialog; it never becomes the value. */
const UPLOAD = "__upload";

const ACCEPT = linkedAccept();

const NONE: LinkedItem[] = [];

function useShelfFonts(): LinkedItem[] {
  return useSyncExternalStore(onLinkedChanged, listLibraryFonts, () => NONE);
}

/** How many titles and cues are set in this font, so a delete says what it
 * costs before it happens. */
function countUses(fontId: string): number {
  const s = useEditor.getState();
  const titles = s.overlays.filter((o) => "font" in o && o.font === fontId).length;
  const cues = s.subtitles.font === fontId ? 1 : 0;
  return titles + cues;
}

export function FontPicker({
  value,
  onChange,
  className,
}: {
  value: string;
  onChange: (id: string) => void;
  className?: string;
}) {
  // The menu re-reads the registry when the bundled families finish registering
  // or a shelf font lands (the bump re-renders, and the render re-reads).
  const [, bump] = useState(0);
  useEffect(() => onFontsChanged(() => bump((n) => n + 1)), []);
  const fonts = allFonts();
  const shelf = useShelfFonts();
  const shelfIds = new Set(shelf.map((f) => libraryFontId(f.key)));
  const built = fonts.filter((f) => !shelfIds.has(f.id));
  // A font whose bytes wouldn't install still lists, so it can still be taken
  // off the shelf; it just has no specimen to set its own name in.
  const mine = shelf.map((f) => {
    const id = libraryFontId(f.key);
    const def = fonts.find((d) => d.id === id);
    return {
      font: f,
      id,
      label: def?.label ?? f.label,
      stack: def?.stack,
      // Only the cloud shelf is readable from a render job.
      deviceOnly: !f.copies.some((c) => c.residency === "cloud"),
    };
  });

  const inputRef = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [confirming, setConfirming] = useState<{ font: LinkedItem; uses: number } | null>(null);

  const upload = async (files: FileList | null) => {
    setBusy(true);
    setError(null);
    // A font download is a zip more often than it is a font, so the archive is
    // opened before anything is judged for being one.
    const file = (await expandLinkedFiles(Array.from(files ?? []))).find(isFontFile);
    if (!file) {
      if (files?.length) setError("That file has no font in it. Try a .ttf, .otf or .woff.");
      setBusy(false);
      return;
    }
    try {
      onChange(await uploadLibraryFont(file));
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not add that font.");
    } finally {
      setBusy(false);
    }
  };

  const remove = async () => {
    const target = confirming?.font;
    setConfirming(null);
    if (!target) return;
    await deleteLinkedItem(target).catch(() => {});
  };

  return (
    <>
      <Select
        value={value}
        items={Object.fromEntries(fonts.map((f) => [f.id, f.label]))}
        onValueChange={(v) => {
          if (v === UPLOAD) {
            inputRef.current?.click();
            return;
          }
          onChange(v as string);
        }}
      >
        <SelectTrigger size="sm" className={cn("w-full", className)} style={{ fontFamily: fontStack(value) }}>
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {built.map((f) => (
            <SelectItem key={f.id} value={f.id}>
              <span style={{ fontFamily: f.stack }}>{f.label}</span>
            </SelectItem>
          ))}
          {mine.length > 0 && <SelectSeparator />}
          {mine.map(({ font, id, label, stack, deviceOnly }) => (
            <SelectItem key={id} value={id}>
              <span className="flex-1 truncate" style={stack ? { fontFamily: stack } : undefined}>
                {label}
              </span>
              {deviceOnly && (
                <span
                  className="text-muted-foreground"
                  title="On this device only — a cloud render falls back to SF Pro"
                >
                  <Laptop className="size-3" aria-label="On this device only" />
                </span>
              )}
              <button
                type="button"
                aria-label={`Delete ${label}`}
                title="Delete this font"
                className="ml-1 rounded p-0.5 text-muted-foreground opacity-60 hover:text-destructive hover:opacity-100"
                onPointerDown={(e) => {
                  e.preventDefault();
                  e.stopPropagation();
                }}
                onClick={(e) => {
                  e.preventDefault();
                  e.stopPropagation();
                  setConfirming({ font, uses: countUses(id) });
                }}
              >
                <Trash2 className="size-3.5" />
              </button>
            </SelectItem>
          ))}
          <SelectSeparator />
          <SelectItem value={UPLOAD}>
            {busy ? <Loader2 className="size-3.5 animate-spin" /> : <Upload className="size-3.5" />}
            <span className="text-muted-foreground">{busy ? "Adding font…" : "Upload font…"}</span>
          </SelectItem>
        </SelectContent>
      </Select>
      {error && <p className="mt-1 text-xs text-destructive">{error}</p>}
      <input
        ref={inputRef}
        type="file"
        accept={ACCEPT}
        hidden
        onChange={(e) => {
          void upload(e.target.files);
          e.target.value = "";
        }}
      />
      <AlertDialog open={!!confirming} onOpenChange={(o) => !o && setConfirming(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete this font?</AlertDialogTitle>
            <AlertDialogDescription>
              It leaves your library and every project that offers it.
              {confirming && confirming.uses > 0
                ? ` ${confirming.uses} ${confirming.uses === 1 ? "title or caption" : "titles and captions"} set in it fall back to SF Pro.`
                : ""}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              className="bg-destructive/10 text-destructive hover:bg-destructive/20"
              onClick={(e) => {
                e.preventDefault();
                void remove();
              }}
            >
              Delete
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}
