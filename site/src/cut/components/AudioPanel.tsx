"use client";

import {
  type DragEventHandler,
  type HTMLAttributes,
  type ReactNode,
  useEffect,
  useRef,
  useState,
} from "react";
import {
  AudioLines,
  Check,
  ChevronDown,
  Info,
  Loader2,
  Music,
  Pause,
  Play,
  Plus,
  Trash2,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { DictationControl } from "@/cut/components/MicDictation";
import { PillSelect } from "@/cut/components/PillSelect";
import { SectionTitle } from "@/cut/components/SectionTitle";
import { SubTabs } from "@/cut/components/SubTabs";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { LiveElapsed } from "@/cut/components/Elapsed";
import { clearAssetDrag, setAssetDragData } from "@/cut/lib/assetDrag";
import { MUSIC_VARIANTS, synthesizeMusic, type MusicVariant } from "@/cut/lib/audioGen";
import { draggingRef, hasRefDrag } from "@/cut/lib/assetRef";
import { useMusicGen } from "@/cut/lib/musicGen";
import { STOCK_MUSIC } from "@/cut/lib/stockMusicManifest";
import { stockAssetInDoc } from "@/cut/lib/genvideo/docWriter";
import { creditsUrl, signInUrl, useSignedIn } from "@/cut/lib/generate";
import { genPulseOverlay, useGenNotify } from "@/cut/lib/genNotify";
import { enrichAsset } from "@/cut/lib/media";
import { waveGain } from "@/cut/lib/waveform";
import { usePreviewAudio } from "@/cut/lib/previewAudio";
import { useEditor } from "@/cut/lib/store";
import { playheadAt } from "@/cut/lib/playhead";
import { formatTime } from "@/cut/lib/time";
import { NoCreditsError, synthesizeSpeech } from "@/cut/lib/tts";
import { useLocalPref } from "@/cut/lib/uiState";
import { DUCK_DEFAULT } from "@/cut/lib/voiceover";
import { useSpeakerVoice, useSpeechLanguage, VoicePicker } from "@/cut/components/VoicePicker";
import { GeneratedAssetMenu } from "@/cut/components/GeneratedAssetMenu";
import { cn } from "@/lib/utils";
import { scrimIconButton } from "@/cut/components/iconButton";
import { ScrollArea } from "@/components/ui/scroll-area";

/** Starting points for the direction prompt — picking one fills the input so
 * it can be tweaked before generating. */
const DIRECTION_PRESETS: { label: string; text: string }[] = [
  { label: "Warm", text: "Say warmly, like an old friend" },
  { label: "Energetic", text: "Say with high energy, like a hype announcer" },
  { label: "Documentary", text: "Narrate calmly and evenly, like a nature documentary" },
  { label: "Movie trailer", text: "Say dramatically, with gravity, like a movie trailer" },
  { label: "News anchor", text: "Read briskly and clearly, like a news anchor" },
  { label: "Whisper", text: "Whisper softly, close to the mic" },
  { label: "Bedtime story", text: "Read slowly and gently, like a bedtime story" },
];

/** The Audio tab: Voice generates an AI voiceover, Music an instrumental bed;
 * each lists what it made as playable rows that drop onto the soundtrack at the
 * playhead, over the shared audio library. Audio files come in through the Media
 * tab or a drop onto the timeline. */
export function AudioPanel({
  projectId,
  importing,
  sub,
  onSub,
}: {
  projectId: string;
  importing: boolean;
  /** The active sub-tab, lifted to SidePanel so it can lay out the Music tab as
   * two columns (this panel + the sample library) like the Image/Video tabs. */
  sub: "voice" | "music";
  onSub: (v: "voice" | "music") => void;
}) {
  const readOnly = useEditor((s) => s.readOnly);
  // The app-wide preview player: starting a clip stops the last one, here or
  // on a chat audio card. Leaving the tab silences only this panel's own
  // preview — a chat card's playback belongs to the chat, which is still on
  // screen.
  const playingUrl = usePreviewAudio((s) => s.url);
  const ownedUrl = useRef<string | null>(null);
  const togglePlay = (url: string) => {
    ownedUrl.current = url;
    usePreviewAudio.getState().toggle(url);
  };
  useEffect(
    () => () => {
      if (ownedUrl.current) usePreviewAudio.getState().stop(ownedUrl.current);
    },
    []
  );

  return (
    <>
      {/* PanelHead's height, so the side panel's floating close button lands
          on the toggle's centerline; the right padding keeps clear of it. */}
      <div className="flex h-12 shrink-0 items-center pr-12 pl-3.5">
        <SubTabs
          tabs={[
            { id: "voice", label: "Voice" },
            { id: "music", label: "Music" },
          ]}
          value={sub}
          onChange={onSub}
        />
      </div>

      <ScrollArea className="min-h-0 flex-1" contentClassName="flex flex-col gap-5 px-3.5 pb-4">
        {sub === "voice" ? (
          <>
            {!readOnly && <VoiceGenerator projectId={projectId} />}
            <ProjectAudio
              projectId={projectId}
              importing={importing}
              onTogglePlay={togglePlay}
              playingUrl={playingUrl}
            />
          </>
        ) : (
          <>
            {!readOnly && <MusicGenerator projectId={projectId} />}
            <ProjectMusic projectId={projectId} onTogglePlay={togglePlay} playingUrl={playingUrl} />
          </>
        )}
      </ScrollArea>
    </>
  );
}

/** The Music generator: describe a mood, pick a length and how many takes, and
 * each generated instrumental lands under "Generated music" to drag onto the
 * soundtrack. Mirrors VoiceGenerator's shape — several syntheses can run at
 * once, so the button stays live and a status row counts them. */
function MusicGenerator({ projectId }: { projectId: string }) {
  // Prompt + vocals mode live in a store so a dragged/clicked sample can seed
  // them for remixing (see musicGen.ts). Lyria sings by default; a bed under
  // narration usually wants no vocals, so the toggle defaults to instrumental.
  const prompt = useMusicGen((s) => s.prompt);
  const setPrompt = useMusicGen((s) => s.setPrompt);
  const instrumental = useMusicGen((s) => s.instrumental);
  const setInstrumental = useMusicGen((s) => s.setInstrumental);
  const [variant, setVariant] = useLocalPref<MusicVariant>(
    "cut-music-variant",
    "clip",
    (v) => v === "clip" || v === "song"
  );
  const [takes, setTakes] = useLocalPref<number>(
    "cut-music-takes",
    1,
    (v) => typeof v === "number" && v >= 1 && v <= 4
  );
  const [pending, setPending] = useState(0);
  // A sample dragged from the library onto the prompt box loads its prompt.
  const [dropActive, setDropActive] = useState(false);
  const droppedSample = (e: React.DragEvent) => {
    if (!hasRefDrag(e)) return undefined;
    const ref = draggingRef();
    if (ref?.scope !== "stock" || ref.kind !== "audio") return undefined;
    return STOCK_MUSIC.find((s) => s.id === ref.id);
  };
  const [error, setError] = useState<{ text: string; credits?: boolean } | null>(null);
  const fail = (e: unknown, fallback: string) =>
    setError(
      e instanceof Error
        ? { text: e.message, credits: e instanceof NoCreditsError }
        : { text: fallback }
    );
  // Music runs on the user's Donkey account, like image/video/voiceover.
  const signedOut = useSignedIn() === false;

  /** Generate `takes` tracks at once; each registers as a generated audio asset
   * that lists below and drops onto the soundtrack. */
  const generate = async () => {
    const text = prompt.trim();
    if (!text) return;
    setError(null);
    const n = takes;
    setPending((p) => p + n);
    await Promise.all(
      Array.from({ length: n }, async () => {
        // Spins the Audio rail tile for the take's whole flight.
        const settle = useGenNotify.getState().begin("audio");
        try {
          const asset = await synthesizeMusic(projectId, text, { variant, instrumental });
          // A render can outlast the open project — the user may switch away
          // while it's in flight. Stock it into the project it was made for, not
          // whatever is on screen now; only the open project touches the store.
          if (useEditor.getState().projectId !== projectId) {
            void stockAssetInDoc(projectId, asset).catch(() => {});
            return;
          }
          // The Audio tab badges its own rail icon when a track finishes while
          // the user stepped away (landed() no-ops while this tab is watched).
          useGenNotify.getState().landed("audio", asset.id);
          useEditor.getState().addAsset(asset);
          void enrichAsset(asset);
        } catch (e) {
          fail(e, "Music generation failed.");
        } finally {
          setPending((p) => p - 1);
          settle();
        }
      })
    );
  };

  const variantLabel = MUSIC_VARIANTS.find((v) => v.id === variant) ?? MUSIC_VARIANTS[0];

  return (
    <div className="music-generator flex flex-col gap-3.5">
      <div className="flex flex-col gap-2">
        <SectionTitle>Describe the music</SectionTitle>
        <div
          className={cn(
            "relative rounded-lg border border-input focus-within:border-ring",
            dropActive && "border-[#0a84ff] ring-2 ring-[#0a84ff]/30 ring-inset"
          )}
          onDragOver={(e) => {
            if (!droppedSample(e)) return;
            e.preventDefault();
            e.dataTransfer.dropEffect = "copy";
            setDropActive(true);
          }}
          onDragLeave={(e) => {
            if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setDropActive(false);
          }}
          onDrop={(e) => {
            const s = droppedSample(e);
            setDropActive(false);
            if (!s) return;
            e.preventDefault();
            useMusicGen.getState().load({ prompt: s.prompt, instrumental: s.category !== "Songs" });
          }}
        >
          <textarea
            className="music-prompt min-h-[88px] w-full resize-y rounded-lg bg-transparent px-2.5 py-2 pr-9 text-[12.5px] leading-relaxed outline-none"
            placeholder="Warm acoustic guitar and soft piano, calm and hopeful — or describe a song to sing"
            value={prompt}
            onChange={(e) => setPrompt(e.target.value)}
          />
          <DictationControl
            text={prompt}
            onResult={setPrompt}
            buttonClassName="absolute right-1.5 bottom-2 bg-background/70 backdrop-blur-sm"
          />
        </div>
        <div className="flex gap-2">
          <PillSelect
            className="h-7 flex-1"
            title="Length"
            value={variant}
            display={variantLabel.label}
            options={MUSIC_VARIANTS.map((v) => ({ value: v.id, label: `${v.label} · ${v.hint}` }))}
            onChange={setVariant}
          />
          <PillSelect
            className="h-7 flex-1"
            title="Takes"
            value={String(takes)}
            display={`${takes} take${takes > 1 ? "s" : ""}`}
            options={[1, 2, 3, 4].map((n) => ({
              value: String(n),
              label: `${n} take${n > 1 ? "s" : ""}`,
            }))}
            onChange={(v) => setTakes(Number(v))}
          />
        </div>
        <div className="flex rounded-lg bg-muted p-0.5 text-[11.5px]">
          {([["song", "Song"], ["instrumental", "Instrumental"]] as const).map(([val, label]) => {
            const active = (val === "instrumental") === instrumental;
            return (
              <button
                key={val}
                type="button"
                onClick={() => setInstrumental(val === "instrumental")}
                title={val === "song" ? "Let the model write and sing lyrics" : "No vocals — a background bed"}
                className={cn(
                  "flex-1 rounded-md px-3 py-0.5 font-medium transition-colors",
                  active
                    ? "bg-background text-foreground shadow-sm"
                    : "text-muted-foreground hover:text-foreground"
                )}
              >
                {label}
              </button>
            );
          })}
        </div>
        <Button
          className="music-generate w-full"
          disabled={!prompt.trim() || signedOut}
          title={!prompt.trim() ? "Describe the music above to generate" : undefined}
          onClick={() => void generate()}
        >
          <Music data-icon="inline-start" />
          Generate music
        </Button>
        {pending > 0 && (
          <div className="flex items-center gap-2 text-[11px] text-muted-foreground">
            <Loader2 className="size-3.5 shrink-0 animate-spin" />
            {pending === 1 ? "Generating…" : `Generating ${pending}…`}
            <LiveElapsed />
          </div>
        )}
      </div>

      {signedOut ? (
        <p className="music-signin text-[11px] leading-relaxed text-muted-foreground">
          Music runs on your Donkey account.{" "}
          <a className="font-medium text-blue-600 hover:underline dark:text-blue-400" href={signInUrl()}>
            Sign in
          </a>{" "}
          to continue.
        </p>
      ) : (
        error && (
          <p className="music-error text-[11px] leading-relaxed text-red-600">
            {error.text}
            {error.credits && (
              <>
                {" "}
                <a
                  className="font-medium underline hover:no-underline"
                  href={creditsUrl()}
                  target="_blank"
                  rel="noreferrer"
                >
                  Add credits
                </a>
              </>
            )}
          </p>
        )
      )}
    </div>
  );
}

function VoiceGenerator({ projectId }: { projectId: string }) {
  const voice = useSpeakerVoice();
  const language = useSpeechLanguage();
  const [script, setScript] = useState("");
  const [direction, setDirection] = useState("");
  // How many syntheses are in flight — several can run at once, so the button
  // stays live and this just drives the status row below it.
  const [pending, setPending] = useState(0);
  // `credits` marks a failure caused by an empty balance, which renders with a
  // link to buy more.
  const [error, setError] = useState<{ text: string; credits?: boolean } | null>(null);
  const fail = (e: unknown, fallback: string) =>
    setError(
      e instanceof Error
        ? { text: e.message, credits: e instanceof NoCreditsError }
        : { text: fallback }
    );
  const directionInput = useRef<HTMLTextAreaElement>(null);
  // Voiceovers run on the user's Donkey account, like image/video generation.
  const signedOut = useSignedIn() === false;

  /** Synthesize the script, register the media asset, and drop one clip on the
   * soundtrack at the playhead. */
  const generate = async () => {
    const text = script.trim();
    if (!text) return;
    setPending((p) => p + 1);
    // The Audio rail tile spins while this runs — the tab is often closed
    // before the voice lands.
    const settle = useGenNotify.getState().begin("audio");
    setError(null);
    try {
      const playhead = playheadAt();
      // Label with the spoken line, not just its first words, so the preview
      // fills across the row (each surface truncates to its own width). Collapse
      // whitespace and cap it so project.json stays lean.
      const lead = text.replace(/\s+/g, " ").trim().slice(0, 200);
      // synthesizeSpeech reads the direction for a "say it in X" ask and
      // translates the script into that language before speaking it.
      const { asset } = await synthesizeSpeech(projectId, [{ text, at: 0 }], {
        voice,
        direction,
        language,
        name: `AI voice — ${lead}`,
      });
      // The Audio tab is the only surface that badges its own rail icon: a
      // voiceover the user generated here, finishing while they stepped away,
      // rides a count. Chat- and scene-made voiceovers never badge — the chat
      // card is their indicator. (landed() no-ops while this tab is watched.)
      useGenNotify.getState().landed("audio", asset.id);
      const cur = useEditor.getState();
      cur.addAsset(asset);
      cur.addAudioFromAsset(asset.id, playhead, {
        // New voiceovers duck everything else to the default; fine-tune on the
        // clip itself ("Duck others" in the inspector).
        duck: DUCK_DEFAULT,
      });
      void enrichAsset(asset);
    } catch (e) {
      fail(e, "Voice generation failed.");
    } finally {
      setPending((p) => p - 1);
      settle();
    }
  };

  return (
    <div className="voice-generator flex flex-col gap-3.5">
      {/* Voice settings first — pick how the voice sounds, then script it. */}
      <VoicePicker
        direction={direction}
        onError={(e) => fail(e, "Could not play the sample.")}
      />

      <div className="flex flex-col gap-1.5">
        <div className="flex items-center gap-1">
          <SectionTitle>Voice direction</SectionTitle>
          <TooltipProvider>
            <Tooltip>
              <TooltipTrigger
                className="voice-direction-info grid size-4 place-items-center text-muted-foreground transition-colors hover:text-foreground"
                aria-label="About voice direction"
              >
                <Info className="size-3.5" />
              </TooltipTrigger>
              <TooltipContent side="right" className="max-w-60">
                Optional. Tell the voice how to deliver the lines — its tone, pace, and energy, or
                ask it to speak in another language.
              </TooltipContent>
            </Tooltip>
          </TooltipProvider>
        </div>
        <div className="relative">
          <textarea
            ref={directionInput}
            rows={2}
            className="voice-direction min-h-[52px] w-full resize-y rounded-lg border border-input bg-transparent py-2 pr-9 pl-2.5 text-[12.5px] leading-relaxed outline-none focus:border-ring"
            placeholder="Say warmly, like an old friend"
            value={direction}
            onChange={(e) => setDirection(e.target.value)}
          />
          <DropdownMenu>
            <DropdownMenuTrigger
              className="voice-direction-presets absolute top-1.5 right-1 grid size-7 place-items-center rounded-md text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
              aria-label="Direction presets"
            >
              <ChevronDown className="size-4" />
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="w-64">
              {DIRECTION_PRESETS.map((p) => (
                <DropdownMenuItem key={p.label} onClick={() => setDirection(p.text)}>
                  <div className="flex min-w-0 flex-1 flex-col">
                    <span className="text-[12px] font-medium">{p.label}</span>
                    <span className="truncate text-[11px] text-muted-foreground">{p.text}</span>
                  </div>
                  {direction === p.text && <Check className="size-3.5 shrink-0" />}
                </DropdownMenuItem>
              ))}
              <DropdownMenuSeparator />
              <DropdownMenuItem
                onClick={() => {
                  setDirection("");
                  // The menu hands focus back to the trigger on close; take it after.
                  setTimeout(() => directionInput.current?.focus(), 0);
                }}
              >
                <span className="text-[12px] font-medium">Custom…</span>
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      </div>

      <div className="h-px shrink-0 bg-border" />

      {/* The script and its generate button stay together so the button's job —
          and why it's disabled until there's a script — is obvious. */}
      <div className="flex flex-col gap-2">
        <SectionTitle>Script</SectionTitle>
        <div className="relative rounded-lg border border-input focus-within:border-ring">
          <textarea
            className="voice-script min-h-[88px] w-full resize-y rounded-lg bg-transparent px-2.5 py-2 pr-9 text-[12.5px] leading-relaxed outline-none"
            placeholder="What should the voice say?"
            value={script}
            onChange={(e) => setScript(e.target.value)}
          />
          <DictationControl
            text={script}
            onResult={setScript}
            buttonClassName="absolute right-1.5 bottom-2 bg-background/70 backdrop-blur-sm"
          />
        </div>
        <Button
          className="voice-generate w-full"
          disabled={!script.trim() || signedOut}
          title={!script.trim() ? "Write a script above to generate" : undefined}
          onClick={() => void generate()}
        >
          <AudioLines data-icon="inline-start" />
          Generate audio
        </Button>
        {pending > 0 && (
          <div className="flex items-center gap-2 text-[11px] text-muted-foreground">
            <Loader2 className="size-3.5 shrink-0 animate-spin" />
            {pending === 1 ? "Generating…" : `Generating ${pending}…`}
            <LiveElapsed />
          </div>
        )}
      </div>

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
            {error.text}
            {error.credits && (
              <>
                {" "}
                <a
                  className="font-medium underline hover:no-underline"
                  href={creditsUrl()}
                  target="_blank"
                  rel="noreferrer"
                >
                  Add credits
                </a>
              </>
            )}
          </p>
        )
      )}
    </div>
  );
}

/** Tiny waveform for a row, from the asset's normalized peaks. Also drawn
 * bigger by the lightbox and the chat's audio cards (`className` restyles). */
export function PeakStrip({ peaks, className }: { peaks: number[]; className?: string }) {
  const BARS = 48;
  const gain = waveGain(peaks);
  const step = Math.max(1, Math.floor(peaks.length / BARS));
  const bars: number[] = [];
  for (let i = 0; i < BARS; i++) {
    let m = 0;
    for (let j = i * step; j < Math.min(peaks.length, (i + 1) * step); j++) {
      if (peaks[j] > m) m = peaks[j];
    }
    bars.push(m);
  }
  return (
    <svg
      viewBox={`0 0 ${BARS * 2} 16`}
      preserveAspectRatio="none"
      className={cn("mt-1 h-4 w-full text-muted-foreground/50", className)}
      aria-hidden
    >
      {bars.map((p, i) => {
        const h = Math.max(1.5, Math.min(1, p * gain) * 16);
        return <rect key={i} x={i * 2} y={(16 - h) / 2} width={1.2} height={h} rx={0.6} fill="currentColor" />;
      })}
    </svg>
  );
}

/** Stand-in peaks while an asset's real ones haven't landed — the same gentle
 * wave the timeline drag ghost draws, so the pill still reads as audio. */
export const STAND_IN_PEAKS = Array.from({ length: 48 }, (_, i) => 0.32 + 0.26 * Math.abs(Math.sin(i / 2)));

/** The emerald audio surface, mirroring a timeline audio clip: gradient pill
 * with a white waveform. Panel rows, chat cards, and attachment tiles draw on
 * it so audio looks like the timeline everywhere it appears. */
export function AudioPillSurface({
  peaks,
  className,
  children,
  ...rest
}: { peaks?: number[] } & HTMLAttributes<HTMLDivElement>) {
  return (
    <div
      className={cn(
        "relative overflow-hidden rounded-[7px] bg-gradient-to-b from-emerald-500 to-emerald-600 shadow-[inset_0_0_0_1px_rgba(0,0,0,0.1)]",
        className
      )}
      {...rest}
    >
      <PeakStrip
        peaks={peaks?.length ? peaks : STAND_IN_PEAKS}
        className="absolute inset-x-0 inset-y-1 mt-0 h-[calc(100%-8px)] text-white/85"
      />
      {children}
    </div>
  );
}

/** Rounded voice-memo bars for the square audio cards — thicker and softer
 * than PeakStrip so they read at card size. */
function CardBars({ peaks, className }: { peaks: number[]; className?: string }) {
  const BARS = 30;
  const gain = waveGain(peaks);
  const step = Math.max(1, Math.floor(peaks.length / BARS));
  const bars: number[] = [];
  for (let i = 0; i < BARS; i++) {
    let m = 0;
    for (let j = i * step; j < Math.min(peaks.length, (i + 1) * step); j++) {
      if (peaks[j] > m) m = peaks[j];
    }
    bars.push(m);
  }
  return (
    <div className={cn("flex items-center gap-[2px]", className)} aria-hidden>
      {bars.map((p, i) => (
        <div
          key={i}
          className="min-w-0 flex-1 rounded-full bg-[#8fcba9]"
          style={{ height: `${Math.round(Math.max(0.15, Math.min(1, p * gain)) * 100)}%` }}
        />
      ))}
    </div>
  );
}

/** The square audio card face: muted green fill, rounded mint bars, a play
 * circle bottom-left, and a duration pill bottom-right. The Library and Media
 * cards drop it in as their audio tile and overlay their own controls. Play
 * goes through the shared preview player; unmounting silences its own preview. */
export function AudioCardFace({
  url,
  duration,
  peaks,
  durationClassName,
}: {
  url: string;
  duration: number;
  peaks?: number[];
  /** Extra classes for the duration pill (e.g. hide it while hover controls
   * take its corner). */
  durationClassName?: string | false;
}) {
  const playing = usePreviewAudio((s) => s.url) === url;
  useEffect(() => () => usePreviewAudio.getState().stop(url), [url]);
  return (
    <div className="relative size-full bg-[#0F6E56]">
      <CardBars
        peaks={peaks?.length ? peaks : STAND_IN_PEAKS}
        className="absolute inset-x-[8%] top-1/2 h-[36%] -translate-y-1/2"
      />
      <button
        type="button"
        title={playing ? "Pause" : "Play"}
        aria-label={playing ? "Pause" : "Play"}
        className="absolute bottom-2 left-2 grid size-8 place-items-center rounded-full bg-[#e3f2e8] text-[#0F6E56] shadow transition-transform hover:scale-105"
        onClick={(e) => {
          e.stopPropagation();
          usePreviewAudio.getState().toggle(url);
        }}
      >
        {playing ? <Pause className="size-3.5" /> : <Play className="size-3.5 translate-x-px" />}
      </button>
      <span
        className={cn(
          "absolute right-2 bottom-3 rounded-md bg-[#2b4e42] px-1.5 py-0.5 font-mono text-[10px] text-[#d6eddf] tabular-nums",
          durationClassName
        )}
      >
        {formatTime(duration)}
      </span>
    </div>
  );
}

/** Off-screen drag image that mirrors an audio clip on the timeline — an
 * emerald pill with the name and a white waveform — so the drag reads as the
 * thing that will land, not the panel row. Lives just long enough for the
 * browser to snapshot it. */
function buildAudioDragGhost(name: string, width: number, peaks?: number[]): HTMLElement {
  const height = 40; // AUDIO_H - 4, matching a timeline audio clip.
  const el = document.createElement("div");
  el.style.cssText =
    `position:absolute;top:-1000px;left:-1000px;pointer-events:none;width:${width}px;height:${height}px;` +
    "border-radius:7px;overflow:hidden;background:linear-gradient(to bottom,#10b981,#059669);" +
    "box-shadow:inset 0 0 0 1px rgba(0,0,0,0.1),0 10px 26px rgba(0,0,0,0.35);";

  const wave = height - 8;
  const canvas = document.createElement("canvas");
  const dpr = window.devicePixelRatio || 1;
  canvas.width = Math.round(width * dpr);
  canvas.height = Math.round(wave * dpr);
  canvas.style.cssText = `position:absolute;left:0;top:4px;width:${width}px;height:${wave}px;`;
  const ctx = canvas.getContext("2d");
  if (ctx) {
    ctx.scale(dpr, dpr);
    ctx.fillStyle = "rgba(255,255,255,0.85)";
    const bars = Math.max(1, Math.floor(width / 3));
    const n = peaks?.length ?? 0;
    const gain = n ? waveGain(peaks!) : 1;
    for (let i = 0; i < bars; i++) {
      // Use the asset's peaks when we have them; otherwise a gentle stand-in so
      // the pill still reads as audio.
      const p = n ? (peaks![Math.min(n - 1, Math.floor((i / bars) * n))] ?? 0) * gain : 0.32 + 0.26 * Math.abs(Math.sin(i / 2));
      const h = Math.max(1.5, Math.min(1, p) * (wave - 2));
      ctx.fillRect(i * 3, (wave - h) / 2, 2, h);
    }
  }
  el.appendChild(canvas);

  const label = document.createElement("span");
  label.textContent = name;
  label.style.cssText =
    "position:absolute;top:3px;left:8px;right:8px;color:rgba(255,255,255,0.9);white-space:nowrap;" +
    "overflow:hidden;text-overflow:ellipsis;text-shadow:0 1px 2px rgba(0,0,0,0.35);" +
    "font:500 9.5px/1.2 ui-sans-serif,system-ui,sans-serif;";
  el.appendChild(label);
  return el;
}

/** One audio asset as a playable pill — the shared audio preview (panels and
 * the chat's audio cards), styled like its timeline clip: emerald gradient,
 * white waveform, name overlaid, plus a play button, duration badge, and a
 * hover-revealed menu + add button. */
export function AudioRow({
  name,
  duration,
  url,
  peaks,
  playing,
  onTogglePlay,
  onAdd,
  menu,
  onDragStart,
  pulse,
}: {
  name: string;
  duration: number;
  url: string;
  peaks?: number[];
  playing: boolean;
  onTogglePlay: (url: string) => void;
  onAdd: () => void;
  /** Extra row actions (a "…" dropdown), rendered before the + button. */
  menu?: ReactNode;
  /** Present when the row can be dragged onto the timeline. */
  onDragStart?: DragEventHandler<HTMLDivElement>;
  /** A freshly-generated clip the user hasn't seen — pulses blue for a beat. */
  pulse?: boolean;
}) {
  return (
    <AudioPillSurface
      peaks={peaks}
      className="audio-row group/row h-10 shrink-0 cursor-grab"
      draggable={!!onDragStart}
      onDragStart={
        onDragStart &&
        ((e) => {
          onDragStart(e);
          // Size the ghost to the clip's on-timeline width (duration × zoom),
          // clamped so a very short or very long clip stays a sane drag image.
          const width = Math.round(
            Math.max(44, Math.min(520, duration * useEditor.getState().pxPerSec))
          );
          const ghost = buildAudioDragGhost(name, width, peaks);
          document.body.appendChild(ghost);
          e.dataTransfer.setDragImage(ghost, Math.min(20, width / 2), 20);
          setTimeout(() => ghost.remove(), 0);
        })
      }
      onDragEnd={onDragStart ? clearAssetDrag : undefined}
      title={onDragStart ? "Drag onto the timeline, or click + to add" : undefined}
    >
      {/* Scrim so the name reads over the white waveform, not just the text-shadow. */}
      <div
        aria-hidden
        className="pointer-events-none absolute inset-x-0 top-0 h-5 rounded-t-[7px] bg-gradient-to-b from-black/45 via-black/25 to-transparent"
      />
      <span className="pointer-events-none absolute top-[3px] right-14 left-8 truncate text-[9.5px] font-medium text-white [text-shadow:0_1px_2px_rgba(0,0,0,0.45)]">
        {name}
      </span>
      <button
        type="button"
        className={cn(
          "absolute top-1/2 left-1.5 grid size-6 shrink-0 -translate-y-1/2 place-items-center rounded-full transition-colors",
          playing ? "bg-white text-emerald-600" : "bg-black/30 text-white hover:bg-black/50"
        )}
        title={playing ? "Pause" : "Play"}
        aria-label={playing ? "Pause" : "Play"}
        onClick={() => onTogglePlay(url)}
      >
        {playing ? <Pause className="size-3" /> : <Play className="size-3" />}
      </button>
      {/* Steps aside when the hover controls take the right edge — the pill is
          too short to stack both without them colliding. */}
      <span className="pointer-events-none absolute right-1.5 bottom-1 rounded-[5px] bg-black/40 px-1 py-px font-mono text-[9px] text-white tabular-nums transition-opacity group-hover/row:opacity-0 has-data-popup-open:opacity-0">
        {formatTime(duration)}
      </span>
      <div className="absolute top-1/2 right-1.5 flex -translate-y-1/2 items-center gap-1.5 opacity-0 transition-opacity group-hover/row:opacity-100 has-data-popup-open:opacity-100">
        {menu}
        <button
          type="button"
          title="Add at the playhead"
          aria-label="Add at the playhead"
          className={scrimIconButton}
          onClick={onAdd}
        >
          <Plus className="size-3" />
        </button>
      </div>
      {pulse && <div aria-hidden className={genPulseOverlay} />}
    </AudioPillSurface>
  );
}

/** Voiceovers are minted as `AI voice — <lead>`; under the "Generated audio"
 * heading the prefix is redundant, so show just the spoken lead here. */
const voiceLabel = (name: string) => name.replace(/^AI voice\s*—\s*/, "");

function ProjectAudio({
  projectId,
  importing,
  onTogglePlay,
  playingUrl,
}: {
  projectId: string;
  importing: boolean;
  onTogglePlay: (url: string) => void;
  playingUrl: string | null;
}) {
  const assets = useEditor((s) => s.assets);
  const audio = assets.filter((a) => a.type === "audio" && a.origin === "voiceover");
  const pulsing = useGenNotify((s) => s.pulsing.audio);
  return (
    <div className="flex flex-col gap-1.5">
      <SectionTitle>Generated audio</SectionTitle>
      {audio.length === 0 && !importing && (
        <p className="text-[11px] leading-relaxed text-muted-foreground">
          No generated audio yet — write a script above and generate one.
        </p>
      )}
      <div className="flex flex-col gap-1.5">
        {audio.map((a) => (
          <AudioRow
            key={a.id}
            name={voiceLabel(a.name)}
            duration={a.duration}
            url={a.url}
            peaks={a.peaks}
            playing={playingUrl === a.url}
            pulse={pulsing.includes(a.id)}
            onTogglePlay={onTogglePlay}
            onAdd={() => useEditor.getState().addAssetAtPlayhead(a.id)}
            menu={
              <GeneratedAssetMenu
                asset={a}
                projectId={projectId}
                triggerClassName={scrimIconButton}
                after={
                  <DropdownMenuItem
                    variant="destructive"
                    onClick={() => useEditor.getState().removeAsset(a.id)}
                  >
                    <Trash2 /> Delete
                  </DropdownMenuItem>
                }
              />
            }
            onDragStart={(e) => setAssetDragData(e, a.id)}
          />
        ))}
        {importing && (
          <div className="flex items-center gap-2 rounded-lg border border-dashed border-input px-2.5 py-2 text-[11px] text-muted-foreground">
            <Loader2 className="size-3.5 animate-spin" /> Importing… <LiveElapsed />
          </div>
        )}
      </div>
    </div>
  );
}

function ProjectMusic({
  projectId,
  onTogglePlay,
  playingUrl,
}: {
  projectId: string;
  onTogglePlay: (url: string) => void;
  playingUrl: string | null;
}) {
  const assets = useEditor((s) => s.assets);
  // Generated instrumentals only — voiceovers list under the Voice tab, and any
  // non-null origin keeps them out of the Media panel.
  const audio = assets.filter((a) => a.type === "audio" && a.origin === "generated");
  const pulsing = useGenNotify((s) => s.pulsing.audio);
  return (
    <div className="flex flex-col gap-1.5">
      <SectionTitle>Generated music</SectionTitle>
      {audio.length === 0 && (
        <p className="text-[11px] leading-relaxed text-muted-foreground">
          No generated music yet — describe a mood above and generate one.
        </p>
      )}
      <div className="flex flex-col gap-1.5">
        {audio.map((a) => (
          <AudioRow
            key={a.id}
            name={a.name}
            duration={a.duration}
            url={a.url}
            peaks={a.peaks}
            playing={playingUrl === a.url}
            pulse={pulsing.includes(a.id)}
            onTogglePlay={onTogglePlay}
            onAdd={() => useEditor.getState().addAssetAtPlayhead(a.id)}
            menu={
              <GeneratedAssetMenu
                asset={a}
                projectId={projectId}
                triggerClassName={scrimIconButton}
                after={
                  <DropdownMenuItem
                    variant="destructive"
                    onClick={() => useEditor.getState().removeAsset(a.id)}
                  >
                    <Trash2 /> Delete
                  </DropdownMenuItem>
                }
              />
            }
            onDragStart={(e) => setAssetDragData(e, a.id)}
          />
        ))}
      </div>
    </div>
  );
}

