"use client";

import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { Captions, ChevronDown, Loader2, Pause, Play } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { SectionTitle } from "@/cut/components/SectionTitle";
import { signInUrl, useSignedIn } from "@/cut/lib/generate";
import { HostedErrorText } from "./hostedError";
import { useGenNotify } from "@/cut/lib/genNotify";
import { useEditor, type EditorState } from "@/cut/lib/store";
import { renderSpeechClip, resolveLanguage, resolveVoice } from "@/cut/lib/tts";
import {
  SPEECH_VOICES,
  VOICE_SAMPLE_TEXT,
  voicePortraitUrl,
  voiceSampleUrl,
} from "@/cut/lib/voices";
import { generateSubtitlesReadout } from "@/cut/lib/voiceover";
import { cn } from "@/lib/utils";

// Shared speech preferences (speaker voice, spoken language) for every surface
// that generates audio (Audio tab, Subtitles tab, clip settings). Module-level
// so all mounted pickers stay in sync; persisted so they survive reloads.
function preference(key: string, resolve: (wanted?: string) => string) {
  let current: string | null = null;
  const listeners = new Set<() => void>();
  return {
    read(): string {
      if (current === null) {
        current = resolve(
          typeof window === "undefined" ? undefined : (localStorage.getItem(key) ?? undefined)
        );
      }
      return current;
    },
    write(id: string) {
      current = resolve(id);
      try {
        localStorage.setItem(key, current);
      } catch {
        // Preference only.
      }
      listeners.forEach((l) => l());
    },
    subscribe(l: () => void) {
      listeners.add(l);
      return () => {
        listeners.delete(l);
      };
    },
  };
}

const voicePref = preference("cut-tts-voice", resolveVoice);
const languagePref = preference("cut-tts-language", resolveLanguage);

/** The shared speaker voice; every generation surface reads this. */
export function useSpeakerVoice(): string {
  return useSyncExternalStore(voicePref.subscribe, voicePref.read, () => resolveVoice(undefined));
}

/** The shared spoken language ("auto" = match the text); every generation
 * surface reads this. */
export function useSpeechLanguage(): string {
  return useSyncExternalStore(languagePref.subscribe, languagePref.read, () =>
    resolveLanguage(undefined)
  );
}

/** A small round persona portrait, used in the trigger and each grid tile. */
function VoiceAvatar({ id, style, className }: { id: string; style: string; className?: string }) {
  return (
    // eslint-disable-next-line @next/next/no-img-element -- bundled static portrait on a client-only page
    <img
      src={voicePortraitUrl(id)}
      alt={`${id}, a ${style.toLowerCase()} voice`}
      loading="lazy"
      className={cn("object-cover", className)}
    />
  );
}

// Women first, then men (grouped, no headers); alphabetical by name within each.
const ORDERED_VOICES = [...SPEECH_VOICES].sort((a, b) =>
  a.gender === b.gender ? a.name.localeCompare(b.name) : a.gender === "f" ? -1 : 1
);

/**
 * Speaker-voice picker: a play button plus a compact dropdown showing the chosen
 * persona. Opening the dropdown reveals a grid of persona portraits — hovering a
 * tile plays that voice's pre-generated sample clip (a static hosted file, so it
 * works signed out and costs nothing), clicking selects it and closes.
 *
 * The play button samples the selected voice reading a fixed line. With no
 * `direction` it just plays the hosted clip; once a delivery `direction` is
 * given ("like a hype announcer") it can't be pre-baked, so it synthesizes a
 * fresh sample through the hosted model instead (signed in, uses credits).
 *
 * Drop it into any surface that generates speech — they all share one persisted
 * voice choice.
 */
export function VoicePicker({
  title = "Speaker voice",
  direction,
  onError,
}: {
  title?: string;
  /** Free-text delivery direction; when non-empty the play button previews via
   * the model instead of the pre-built clip. */
  direction?: string;
  /** Surfaced when a live (direction) preview fails — e.g. no credits. */
  onError?: (e: unknown) => void;
}) {
  const voice = useSpeakerVoice();
  const language = useSpeechLanguage();
  const selected = SPEECH_VOICES.find((v) => v.id === voice) ?? SPEECH_VOICES[0];
  const [open, setOpen] = useState(false);
  const [sampling, setSampling] = useState<null | "loading" | "playing">(null);
  const audio = useRef<HTMLAudioElement | null>(null);
  const sampleSeq = useRef(0);

  // Stop any preview when the picker unmounts (menu close is handled in onOpenChange).
  useEffect(() => () => audio.current?.pause(), []);

  const preview = (id: string) => {
    const el = (audio.current ??= new Audio());
    el.src = voiceSampleUrl(id);
    el.currentTime = 0;
    // Autoplay refusal or a missing file just leaves it silent.
    void el.play().catch(() => {});
  };

  const leave = (id: string) => {
    // Only silence the element if this tile owned the current clip.
    if (audio.current?.src.endsWith(`${id.toLowerCase()}.mp3`)) audio.current.pause();
  };

  // Play button: sample the selected voice. A delivery direction can't be
  // pre-baked, so it routes through the model; otherwise the hosted clip plays.
  const sample = async () => {
    const el = (audio.current ??= new Audio());
    if (sampling) {
      el.pause();
      setSampling(null);
      sampleSeq.current++;
      return;
    }
    const dir = direction?.trim();
    const seq = ++sampleSeq.current;
    setSampling("loading");
    try {
      let url: string;
      if (dir) {
        const { blob } = await renderSpeechClip([{ text: VOICE_SAMPLE_TEXT, at: 0 }], {
          voice: selected.id,
          direction: dir,
          language,
        });
        url = URL.createObjectURL(blob);
      } else {
        url = voiceSampleUrl(selected.id);
      }
      if (seq !== sampleSeq.current) return;
      el.src = url;
      el.onended = () => setSampling(null);
      el.onerror = () => setSampling(null);
      setSampling("playing");
      await el.play();
    } catch (e) {
      if (seq !== sampleSeq.current) return;
      setSampling(null);
      onError?.(e);
    }
  };

  return (
    <div className="voice-picker flex flex-col gap-1.5">
      <SectionTitle>{title}</SectionTitle>
      <div className="flex items-stretch gap-2">
        <button
          type="button"
          className="voice-sample grid size-[34px] shrink-0 place-items-center rounded-lg border border-input text-foreground transition-colors hover:bg-muted"
          title={direction?.trim() ? "Hear this voice with your direction" : "Hear this voice"}
          aria-label="Play a sample of the selected voice"
          onClick={() => void sample()}
        >
          {sampling === "loading" ? (
            <Loader2 className="size-4 animate-spin" />
          ) : sampling === "playing" ? (
            <Pause className="size-4" />
          ) : (
            <Play className="size-4" />
          )}
        </button>
        <DropdownMenu
          open={open}
          onOpenChange={(next) => {
            setOpen(next);
            if (!next && !sampling) audio.current?.pause();
          }}
        >
        <DropdownMenuTrigger className="voice-select flex min-w-0 flex-1 items-center gap-2.5 overflow-hidden rounded-lg border border-input bg-transparent pr-2.5 text-left outline-none transition-colors focus:border-ring">
          <VoiceAvatar
            id={selected.id}
            style={selected.style}
            className="size-8 shrink-0 bg-muted"
          />
          <span className="min-w-0 flex-1 truncate text-[12.5px]">
            <span className="font-semibold">{selected.name}</span>{" "}
            <span className="text-muted-foreground">· {selected.style}</span>
          </span>
          <ChevronDown className="size-4 shrink-0 text-muted-foreground" />
        </DropdownMenuTrigger>
        <DropdownMenuContent className="max-h-96 w-96 max-w-[calc(100vw-2rem)] p-2.5">
          {/* Women and men each get their own grid so the men always start on a
              fresh row (grouped, no section headers). */}
          <div className="flex flex-col gap-3">
            {[
              ORDERED_VOICES.filter((v) => v.gender === "f"),
              ORDERED_VOICES.filter((v) => v.gender === "m"),
            ].map((group, i) => (
              <div key={i} className="voice-grid grid grid-cols-5 gap-2">
                {group.map((v) => {
                  const isSelected = v.id === voice;
                  return (
                    <button
                      key={v.id}
                      type="button"
                      className="voice-tile group flex flex-col gap-1 text-left"
                      aria-pressed={isSelected}
                      title={`${v.name} · ${v.style}`}
                      onClick={() => {
                        voicePref.write(v.id);
                        setOpen(false);
                      }}
                      onMouseEnter={() => preview(v.id)}
                      onMouseLeave={() => leave(v.id)}
                      onFocus={() => preview(v.id)}
                      onBlur={() => leave(v.id)}
                    >
                      <span
                        className={cn(
                          "block aspect-square overflow-hidden rounded-lg border bg-muted ring-offset-2 ring-offset-popover transition",
                          isSelected
                            ? "border-transparent ring-2 ring-[#0a84ff]"
                            : "border-input group-hover:border-transparent group-hover:ring-2 group-hover:ring-[#0a84ff]/40"
                        )}
                      >
                        <VoiceAvatar id={v.id} style={v.style} className="size-full" />
                      </span>
                      <span className="min-w-0 px-0.5 leading-tight">
                        <span className="block truncate text-[11px] font-semibold">{v.name}</span>
                        <span className="block truncate text-[10px] text-muted-foreground">
                          {v.style}
                        </span>
                      </span>
                    </button>
                  );
                })}
              </div>
            ))}
          </div>
        </DropdownMenuContent>
      </DropdownMenu>
      </div>
    </div>
  );
}

/** The cue ids the readout covers: `select`'s scope, or every non-empty cue. */
function scopedCueIds(s: EditorState, select?: (s: EditorState) => string[]): string[] {
  return select ? select(s) : s.subtitles.cues.filter((c) => c.text.trim()).map((c) => c.id);
}

/**
 * Self-contained "voice the subtitles" block: the voice picker plus a generate
 * button and its error line. `selectCueIds` scopes the readout (e.g. the cues
 * inside one clip); absent = every cue. When the scope has no cues yet,
 * Generate transcribes the cut first and then voices the fresh cues.
 */
export function GenerateSubtitlesAudio({
  selectCueIds,
  ensureCues,
  label = "Generate audio for subtitles",
}: {
  selectCueIds?: (s: EditorState) => string[];
  /** Makes cues exist when the scope has none, matched to that scope (e.g.
   * transcribe just the clip); defaults to transcribing the whole cut. Throws
   * a user-facing error on failure. */
  ensureCues?: () => Promise<void>;
  label?: string;
}) {
  const voice = useSpeakerVoice();
  const language = useSpeechLanguage();
  const signedOut = useSignedIn() === false;
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<{ text: string } | null>(null);
  const cueCount = useEditor((s) => scopedCueIds(s, selectCueIds).length);
  const hasVideo = useEditor((s) => s.clips.length > 0);

  const generate = async () => {
    setBusy(true);
    setError(null);
    // A voiceover like the Audio tab's own: its rail tile spins for the
    // flight, and the landed clip badges it if the user stepped away.
    const settle = useGenNotify.getState().begin("audio");
    try {
      if (scopedCueIds(useEditor.getState(), selectCueIds).length === 0) {
        // Nothing to read yet — transcribe first, then voice the fresh cues.
        if (ensureCues) {
          await ensureCues();
        } else {
          if (useEditor.getState().subtitleStatus === "running") {
            throw new Error("Subtitles are still generating — try again in a moment.");
          }
          await useEditor.getState().generateSubtitles();
          const after = useEditor.getState();
          if (after.subtitleStatus === "error") {
            throw new Error(after.subtitleError ?? "Transcription failed.");
          }
        }
        if (scopedCueIds(useEditor.getState(), selectCueIds).length === 0) {
          throw new Error("No speech found to voice.");
        }
      }
      const { asset } = await generateSubtitlesReadout(voice, {
        cueIds: selectCueIds?.(useEditor.getState()),
        language,
      });
      useGenNotify.getState().landed("audio", asset.id);
    } catch (e) {
      setError({
        text: e instanceof Error ? e.message : "Voice generation failed.",
      });
    } finally {
      setBusy(false);
      settle();
    }
  };

  return (
    <div className="subtitles-audio flex flex-col gap-2.5">
      <VoicePicker title="Generated audio" />
      <Button
        variant="outline"
        className="voice-readout w-full"
        disabled={busy || signedOut || (cueCount === 0 && !hasVideo)}
        title={
          cueCount === 0
            ? hasVideo
              ? "Transcribe the speech, then voice it onto the soundtrack"
              : "Add a video to the timeline first"
            : "Voice the subtitle text and drop it on the soundtrack"
        }
        onClick={() => void generate()}
      >
        {busy ? <Loader2 className="animate-spin" /> : <Captions data-icon="inline-start" />}
        {label}
      </Button>
      {signedOut ? (
        <p className="voice-signin text-[11px] leading-relaxed text-muted-foreground">
          Voiceovers run on your Donkey account.{" "}
          <a className="font-medium text-blue-600 hover:underline dark:text-blue-400" href={signInUrl()}>
            Sign in
          </a>{" "}
          to continue.
        </p>
      ) : (
        error && (
          <p className="voice-error text-[11px] leading-relaxed text-red-600">
            <HostedErrorText error={error.text} />
          </p>
        )
      )}
    </div>
  );
}
