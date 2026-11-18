"use client";

import { useEffect, useRef } from "react";
import { Check, Mic, X } from "lucide-react";
import { useTranslations } from "next-intl";
import { cn } from "@/lib/utils";
import { useCutCaps } from "@/cut/lib/backend/hooks";
import { useMicTranscription, type MicController } from "@/cut/lib/micTranscribe";
import { LiveWaveform } from "./LiveWaveform";
import { useChatError } from "./chatError";

// Shared voice-dictation UI, used by every prompt input (the AI chat composer
// and the image / video / audio generation prompts). The capture + on-device
// transcription live in lib/micTranscribe.ts; this is the presentation:
//  - DictationText: the live transcript, in the place of the input's text.
//  - DictationBar: a level meter with cancel (✕) and use (✓), in the place of
//    the input's toolbar row. The composers swap both in place; embedded
//    inputs stack them inside an overlay.
//  - DictationControl: a mic trigger plus that overlay, for dropping into any
//    input whose container is `relative`.

/** Append a fresh transcript after whatever the user had already typed. */
export function appendTranscript(existing: string, transcript: string): string {
  const base = existing.trim();
  return base ? `${base} ${transcript}` : transcript;
}

/** Enter confirms and Escape cancels while a dictation records. Captured on
 * window so an input still focused under the dictation never sees the key. */
function useDictationKeys({ state, confirm, cancel }: MicController) {
  useEffect(() => {
    if (state !== "recording") return;
    const onKey = (e: KeyboardEvent) => {
      if (e.isComposing) return;
      if (e.key === "Enter" && !e.shiftKey && !e.metaKey && !e.ctrlKey && !e.altKey) {
        e.preventDefault();
        e.stopPropagation();
        void confirm();
      } else if (e.key === "Escape") {
        e.preventDefault();
        e.stopPropagation();
        cancel();
      }
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [state, confirm, cancel]);
}

/** The words so far, in the place of the input they will land in. `text` is
 * the input's current value and the live partial follows it. `minHeight`
 * holds the input's height so the box never shrinks; a long take grows it up
 * to the max height its classes set, then scrolls to keep the newest words in
 * view. */
export function DictationText({
  text,
  mic,
  minHeight,
  className,
}: {
  text: string;
  mic: MicController;
  minHeight?: number;
  className?: string;
}) {
  const shown = [text.trim(), mic.partial].filter(Boolean).join(" ");
  const boxRef = useRef<HTMLDivElement>(null);

  // Follow the newest words once the take outgrows the box.
  useEffect(() => {
    const box = boxRef.current;
    if (box) {
      box.scrollTop = box.scrollHeight;
    }
  }, [shown]);

  return (
    <div
      ref={boxRef}
      style={{ minHeight }}
      className={cn("overflow-y-auto break-words whitespace-pre-wrap", className)}
    >
      {shown}
    </div>
  );
}

/** The level meter with cancel (✕) and use (✓), sized to stand in for an
 * input's toolbar row while it records. */
export function DictationBar({
  mic,
  className,
  buttonClassName,
}: {
  mic: MicController;
  className?: string;
  buttonClassName?: string;
}) {
  const t = useTranslations("chat.dictation");
  const finishing = mic.state === "finishing";
  // Confirm only means something once capture is live; while the graph is
  // still coming up the button says so instead of swallowing the click.
  const ready = mic.state === "recording";
  useDictationKeys(mic);
  return (
    <div className={cn("flex min-w-0 flex-1 items-center gap-2", className)}>
      {mic.stream ? (
        <LiveWaveform
          stream={mic.stream}
          sampleMs={130}
          className="h-7 min-w-0 flex-1 text-muted-foreground/70"
        />
      ) : (
        // Without the app the take is transcribed after the stop, which is a
        // round trip the meter's empty slot can say out loud.
        <div className="flex-1 px-1 text-[11px] text-muted-foreground/70">
          {finishing ? t("transcribing") : null}
        </div>
      )}
      <button
        type="button"
        aria-label={t("cancel")}
        disabled={finishing}
        onClick={mic.cancel}
        className={cn(
          "grid size-7 shrink-0 place-items-center rounded-lg bg-muted text-muted-foreground transition-colors hover:bg-muted/70 disabled:opacity-50",
          buttonClassName
        )}
      >
        <X className="size-3.5" />
      </button>
      <button
        type="button"
        aria-label={t("useTranscription")}
        disabled={!ready}
        onClick={() => void mic.confirm()}
        className={cn(
          "grid size-7 shrink-0 place-items-center rounded-lg bg-[#0a84ff] text-white transition-colors hover:bg-[#0a84ff]/90 disabled:opacity-50",
          buttonClassName
        )}
      >
        <Check className="size-3.5" />
      </button>
    </div>
  );
}

/** The transcript over the bar, for the overlay embedded inputs show. */
function DictationBody({ text, mic }: { text: string; mic: MicController }) {
  return (
    <div className="flex h-full min-h-[72px] flex-col">
      <DictationText
        text={text}
        mic={mic}
        className="min-h-0 flex-1 px-3 pt-2.5 text-[12.5px] leading-relaxed"
      />
      <DictationBar mic={mic} className="flex-none px-2 pt-1 pb-2" />
    </div>
  );
}

/** A mic trigger that, while recording, overlays its input with the live
 * transcript. Drop it inside a `relative` container; on confirm the transcript
 * is appended to `text` via `onResult`. */
export function DictationControl({
  text,
  onResult,
  buttonClassName,
  disabled,
}: {
  text: string;
  onResult: (transcript: string) => void;
  buttonClassName?: string;
  disabled?: boolean;
}) {
  const t = useTranslations("chat.dictation");
  const chatError = useChatError();
  const caps = useCutCaps();
  const mic = useMicTranscription((transcript) => onResult(appendTranscript(text, transcript)));
  if (!caps.liveMic) return null;
  return (
    <>
      {mic.state !== "idle" && (
        <div className="absolute inset-0 z-20 overflow-hidden rounded-[inherit] bg-background/95 backdrop-blur-sm">
          <DictationBody text={text} mic={mic} />
        </div>
      )}
      {mic.state === "idle" && (
        <button
          type="button"
          title={t("dictate")}
          disabled={disabled}
          onClick={() => void mic.start()}
          className={cn(
            "grid size-7 place-items-center rounded-md text-muted-foreground/70 transition-colors hover:bg-muted hover:text-foreground disabled:opacity-40",
            buttonClassName
          )}
        >
          <Mic className="size-3.5" />
        </button>
      )}
      {mic.error && mic.state === "idle" && (
        <div className="absolute right-1 bottom-full z-30 mb-1 max-w-[240px] rounded-md bg-popover px-2 py-1 text-[10.5px] leading-snug text-amber-700 shadow-md">
          {chatError(mic.error)}
        </div>
      )}
    </>
  );
}
