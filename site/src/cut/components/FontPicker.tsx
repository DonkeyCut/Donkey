"use client";

/**
 * The font menu, shared by the title inspector and the caption panel.
 *
 * One list: the base system set, the bundled families, and the account's own
 * fonts off the Library shelf, every row set in its own face. It is also where
 * a font file gets onto that shelf in the first place, through the "Upload
 * font" row at the bottom. Taking one off again is the Library's job, where the
 * font is an item like any other.
 */

import { Loader2, Upload } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectLabel,
  SelectSeparator,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { isFontFile } from "@/cut/lib/media";
import {
  expandLinkedFiles,
  libraryFontId,
  linkedAccept,
  listLibraryFonts,
  onLinkedChanged,
  uploadLibraryFont,
} from "@/cut/lib/linkedLibrary";
import { allFonts, fontStack, onFontsChanged } from "@/cut/lib/types";
import { cn } from "@/lib/utils";

/** Room left either side of the menu inside its panel. */
const PANEL_INSET = 24;

/** Picking this row opens the file dialog; it never becomes the value. */
const UPLOAD = "__upload";

const ACCEPT = linkedAccept();

/** The row's text size, and the cap height it is drawn to. */
const ROW_PX = 14;
const CAP_PX = 10;

const capScale = new Map<string, number>();
let pen: CanvasRenderingContext2D | null = null;

/**
 * How much to scale a face so its capitals stand as tall as everybody else's.
 *
 * A point size is the em box, and faces spend it differently — a script sets
 * its capitals at half the em where a grotesque sets them at three quarters —
 * so one size down the menu reads as a jumble of sizes. Each face is measured
 * once, against the height its own capitals draw at.
 */
function rowSize(stack: string | undefined): number {
  if (!stack) return ROW_PX;
  const held = capScale.get(stack);
  if (held !== undefined) return ROW_PX * held;
  if (typeof document === "undefined") return ROW_PX;
  // An unloaded face measures as the fallback, which would cache the wrong
  // number; the menu re-renders when fonts land and asks again.
  if (!document.fonts.check(`${ROW_PX}px ${stack}`)) return ROW_PX;
  pen ??= document.createElement("canvas").getContext("2d");
  if (!pen) return ROW_PX;
  pen.font = `100px ${stack}`;
  const cap = pen.measureText("H").actualBoundingBoxAscent;
  const scale =
    cap > 0 ? Math.min(2, Math.max(0.8, ((CAP_PX / cap) * 100) / ROW_PX)) : 1;
  capScale.set(stack, scale);
  return ROW_PX * scale;
}

/** One font's row, set in itself at the size the menu reads at. */
const row = (f: { id: string; label: string; stack?: string }) => (
  <SelectItem key={f.id} value={f.id}>
    <span
      className="leading-6"
      style={{ fontFamily: f.stack, fontSize: rowSize(f.stack) }}
    >
      {f.label}
    </span>
  </SelectItem>
);

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
  const again = () => bump((n) => n + 1);
  useEffect(() => onFontsChanged(again), []);
  useEffect(() => onLinkedChanged(again), []);
  const fonts = allFonts();
  // The user's own fonts get their own heading; everything else is the set the
  // editor ships with.
  const shelf = new Set(listLibraryFonts().map((f) => libraryFontId(f.key)));
  const built = fonts.filter((f) => !shelf.has(f.id));
  const mine = fonts.filter((f) => shelf.has(f.id));

  const inputRef = useRef<HTMLInputElement>(null);
  // The menu takes the width of the panel it drops out of: a font name sets in
  // its own face, and a face that runs wide needs the room the field alone
  // doesn't have. It hangs from the field's right edge back across the panel.
  const triggerRef = useRef<HTMLButtonElement>(null);
  const [menuWidth, setMenuWidth] = useState<number>();
  const measure = () => {
    const el = triggerRef.current;
    if (!el) return;
    const panel = el.closest("[data-field-panel]");
    setMenuWidth(
      Math.max(el.offsetWidth, (panel?.clientWidth ?? 0) - PANEL_INSET),
    );
  };
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const upload = async (files: FileList | null) => {
    setBusy(true);
    setError(null);
    // A font download is a zip more often than it is a font, so the archive is
    // opened before anything is judged for being one.
    const file = (await expandLinkedFiles(Array.from(files ?? []))).find(
      isFontFile,
    );
    if (!file) {
      if (files?.length)
        setError("That file has no font in it. Try a .ttf, .otf or .woff.");
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

  return (
    <>
      <Select
        value={value}
        items={Object.fromEntries(fonts.map((f) => [f.id, f.label]))}
        onOpenChange={(open) => {
          if (open) measure();
        }}
        onValueChange={(v) => {
          if (v === UPLOAD) {
            inputRef.current?.click();
            return;
          }
          onChange(v as string);
        }}
      >
        <SelectTrigger
          ref={triggerRef}
          size="sm"
          className={cn("w-full", className)}
          style={{
            fontFamily: fontStack(value),
            fontSize: rowSize(fontStack(value)),
          }}
        >
          <SelectValue />
        </SelectTrigger>
        {/* The menu is the field's own width: a face's name sets in a face
            that runs wide, and the panel it drops out of is narrow. */}
        <SelectContent
          align="end"
          alignItemWithTrigger={false}
          style={
            menuWidth ? { width: menuWidth, maxWidth: menuWidth } : undefined
          }
        >
          {built.map(row)}
          {mine.length > 0 && (
            <>
              <SelectSeparator />
              <SelectGroup>
                <SelectLabel>Custom fonts</SelectLabel>
                {mine.map(row)}
              </SelectGroup>
            </>
          )}
          <SelectSeparator />
          <SelectItem value={UPLOAD}>
            <span className="flex items-center gap-2 text-muted-foreground">
              {busy ? (
                <Loader2 className="size-3.5 animate-spin" />
              ) : (
                <Upload className="size-3.5" />
              )}
              {busy ? "Adding font…" : "Upload font…"}
            </span>
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
    </>
  );
}
