"use client";

import { AudioCardFace } from "@/cut/components/AudioPanel";
import { FolderGlyph } from "@/cut/components/desktopFolders";
import { SPECIMEN_BG, SPECIMEN_INK } from "@/cut/lib/fontSpecimen";
import { noteColor, NOTE_INK } from "@/cut/lib/notes";
import { NoteBodyPreview } from "./NoteBodyPreview";
import { cn } from "@/lib/utils";

// The faces an attachment card wears, the way Assets draws each type: a
// picture shows itself, a sound is the green audio card, a note its paper, a
// folder the folder glyph, a font a specimen. Anything with no picture is its
// name and a badge for its type. Home's prompt box and the chat's sent
// messages draw the same cards.

/** The square every attachment card fills. */
export const ATTACHMENT_CARD =
  "relative size-28 shrink-0 overflow-hidden rounded-xl border border-border bg-muted text-muted-foreground";

/** A label laid over a picture that could be mistaken for a clip, e.g.
 * "Template". */
export function FaceLabel({ children }: { children: React.ReactNode }) {
  return (
    <span className="absolute bottom-1.5 left-1.5 rounded-md bg-black/65 px-1.5 py-0.5 text-[10px] font-medium text-white">
      {children}
    </span>
  );
}

/** A file's type as its badge reads: the extension, e.g. "MOV". */
export function extensionOf(fileName: string): string | null {
  const dot = fileName.lastIndexOf(".");
  return dot > 0 ? fileName.slice(dot + 1).toUpperCase() : null;
}

/** The card for something with no picture: its name, and its type below. */
export function TextFace({
  name,
  badge,
}: {
  name: string;
  badge?: string | null;
}) {
  return (
    <span className="flex size-full flex-col justify-between p-2.5 text-left">
      <span className="line-clamp-3 text-[12px] leading-snug font-medium break-words text-foreground">
        {name}
      </span>
      {badge && (
        <span className="self-start rounded-full border border-foreground/25 px-1.5 py-px text-[10px] font-medium tracking-wide text-muted-foreground">
          {badge}
        </span>
      )}
    </span>
  );
}

/** A note the way Assets shows it: its paper, in its colour, with its title
 * over the opening lines. Paper stays light in dark mode, like the open
 * note. */
export function NoteFace({
  title,
  body,
  colorIndex,
}: {
  title: string;
  body: string;
  colorIndex: number;
}) {
  return (
    <span
      className="light flex size-full flex-col gap-1 p-2.5 text-left"
      style={{
        backgroundColor: noteColor(colorIndex).background,
        color: NOTE_INK,
      }}
    >
      {title && (
        <span className="truncate text-[12px] leading-snug font-semibold">
          {title}
        </span>
      )}
      <NoteBodyPreview
        body={body}
        lines={title ? 4 : 5}
        className="text-[11px] leading-snug opacity-80"
      />
    </span>
  );
}

/** A folder: the folder glyph over its name. */
export function FolderFace({ name }: { name: string }) {
  return (
    <span className="flex size-full flex-col items-center justify-center gap-1.5 px-2 text-foreground">
      <FolderGlyph className="size-12 shrink-0 drop-shadow-sm" />
      <span className="w-full truncate text-center text-[11px] font-medium">
        {name}
      </span>
    </span>
  );
}

/** A font: a specimen over its name. */
export function FontFace({ name }: { name: string }) {
  return (
    <span
      className="flex size-full flex-col justify-between p-2.5"
      style={{ backgroundColor: SPECIMEN_BG, color: SPECIMEN_INK }}
    >
      <span className="text-3xl font-semibold">Aa</span>
      <span className="truncate text-[11px] font-medium opacity-70">
        {name}
      </span>
    </span>
  );
}

/** A sound: the green card Assets plays it from, its name across the top. */
export function AudioFace({
  url,
  duration,
  name,
}: {
  url: string;
  duration: number;
  name: string;
}) {
  return (
    <>
      <AudioCardFace url={url} duration={duration} />
      <span className="pointer-events-none absolute inset-x-0 top-0 truncate px-2.5 pt-2 text-[11px] font-medium text-white">
        {name}
      </span>
    </>
  );
}

/** A card frame for a face, e.g. a sent message's attachment. */
export function AttachmentCard({
  className,
  children,
}: {
  className?: string;
  children: React.ReactNode;
}) {
  return <div className={cn(ATTACHMENT_CARD, className)}>{children}</div>;
}
