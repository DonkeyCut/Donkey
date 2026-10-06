"use client";

import React, { memo, useEffect, useRef, useState } from "react";
import { AlertCircle, Captions, ChevronDown, Languages, Loader2, RefreshCw } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import { ColorField } from "@/cut/components/ColorField";
import { FontPicker } from "@/cut/components/FontPicker";
import { parseNumberInput, parsePercentInput, parseSpeedInput } from "@/cut/components/ScrubValue";
import { ValueSlider } from "@/cut/components/ValueSlider";
import { GenerateSubtitlesAudio } from "@/cut/components/VoicePicker";
import {
  CAPTION_STYLES,
  captionEmphasis,
  captionWords,
  captionStyle,
  EMPHASIS_SCALE_MAX,
  EMPHASIS_SCALE_MIN,
  fmtCueTime,
  laneCues,
  subtitleLaneCount,
  trackLocale,
} from "@/cut/lib/subtitles";
import { cueEmphasis, emphasisRuns, wordIndicesIn } from "@/cut/lib/captionEmphasis";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem } from "@/components/ui/dropdown-menu";
import {
  cueWordCount,
  MAX_WORDS_PER_CUE,
  MIN_WORDS_PER_CUE,
  DEFAULT_WORDS_PER_CUE,
} from "@/cut/lib/cueChunk";
import { useElapsed } from "@/cut/hooks/useElapsed";
import { useCutCaps } from "@/cut/lib/backend/hooks";
import { useActiveWork, useGenNotify } from "@/cut/lib/genNotify";
import { TIMELINE_H_MIN, useEditor } from "@/cut/lib/store";
import { PANEL_GLOBAL, usePanelState } from "@/cut/lib/panelState";
import { usePreviewSelector } from "@/cut/lib/playhead";
import { PLATE_PAD_X, PLATE_PAD_Y, PLATE_RADIUS, plateFill } from "@/cut/lib/textRender";
import {
  fontStack,
  type FontId,
  type SubtitleCue,
  type SubtitlesBlock,
} from "@/cut/lib/types";
import { cn } from "@/lib/utils";
import { ScrollArea } from "@/components/ui/scroll-area";
import { PillSelect } from "@/cut/components/PillSelect";
import {
  wordAccent,
  wordDim,
  wordEffect,
  wordKnobs,
  wordSwell,
  WORD_EFFECT_MENU,
  WORD_POP_SCALE,
  WORD_SWELL_MAX,
  WORD_SWELL_MIN,
} from "@donkeycut/effects-kit";

const LOCALES = [
  ["en-US", "English (US)"],
  ["en-GB", "English (UK)"],
  ["es-ES", "Español"],
  ["fr-FR", "Français"],
  ["de-DE", "Deutsch"],
  ["it-IT", "Italiano"],
  ["pt-BR", "Português (BR)"],
  ["ja-JP", "日本語"],
  ["ko-KR", "한국어"],
  ["zh-CN", "中文"],
  ["vi-VN", "Tiếng Việt"],
] as const;

/** Give the cue track room when it appears. */
const TIMELINE_H_WITH_SUBS = Math.max(TIMELINE_H_MIN, 276);

/** Ticking clock beside the running transcription/translation label. */
function SubtitleElapsed() {
  const startedAt = useEditor((s) => s.subtitleStartedAt);
  const elapsed = useElapsed(startedAt);
  return elapsed ? <span className="tabular-nums text-muted-foreground">{elapsed}</span> : null;
}

/** A track's short pill label: its language code (EN, KO, …). */
function laneLabel(subs: SubtitlesBlock, lane: number): string {
  return trackLocale(subs, lane).split("-")[0].toUpperCase();
}

/** A track's language name from the locale picker list, else its short code. */
function laneLanguage(subs: SubtitlesBlock, lane: number): string {
  return LOCALES.find(([id]) => id === trackLocale(subs, lane))?.[1] ?? laneLabel(subs, lane);
}

export function SubtitlesPanel() {
  const caps = useCutCaps();
  const readOnly = useEditor((s) => s.readOnly);
  const subtitles = useEditor((s) => s.subtitles);
  const lane = useEditor((s) => s.subtitleLane);
  const status = useEditor((s) => s.subtitleStatus);
  const error = useEditor((s) => s.subtitleError);
  const activeCues = laneCues(subtitles, lane);
  const hasCues = activeCues.length > 0;
  // The open tab holds for the session, so leaving the panel and coming back
  // lands on the same one.
  const [tab, setTab] = usePanelState<"content" | "styles" | "options">(
    PANEL_GLOBAL,
    "subtitlesTab",
    "content"
  );

  const growTimeline = () => {
    const cur = useEditor.getState();
    // Multiple tracks stack rows, so give the timeline room per track.
    const want = TIMELINE_H_WITH_SUBS + (subtitleLaneCount(cur.subtitles) - 1) * 22;
    if (cur.subtitles.cues.length > 0 && cur.timelineH < want) cur.setTimelineH(want);
  };

  const generate = () => {
    void useEditor.getState().generateSubtitles().then(growTimeline);
  };

  const translate = (fromLane: number) => {
    // Registered so the running panel knows which pass it is watching even
    // after the tab was closed and reopened — the local flag went with the
    // unmount and the wait then read as a transcription.
    const settle = useGenNotify.getState().begin("subtitles", "translate");
    void useEditor
      .getState()
      .translateSubtitleTrack(fromLane)
      .then(growTimeline)
      .finally(settle);
  };

  // A shared view reads the transcript; styling and generation stay the
  // owner's.
  if (readOnly) {
    return (
      <>
        <div className="flex h-12 shrink-0 items-center pl-4">
          <span className="text-sm font-semibold tracking-tight">Subtitles</span>
        </div>
        {hasCues ? (
          <Transcript cues={activeCues} />
        ) : (
          <p className="px-4 text-[11px] leading-relaxed text-muted-foreground">
            No subtitles yet.
          </p>
        )}
      </>
    );
  }

  return (
    <>
      <div className="flex h-12 shrink-0 items-center justify-between pr-2.5 pl-4">
        {hasCues ? (
          <div className="sub-tabs flex items-center gap-3.5">
            {(
              [
                ["content", "Content"],
                ["styles", "Styles"],
                ["options", "Options"],
              ] as const
            ).map(([id, label], i) => (
              <React.Fragment key={id}>
                {i > 0 && <span aria-hidden className="h-4 w-px bg-border" />}
                <button
                  className={cn(
                    "text-sm font-semibold tracking-tight transition-colors",
                    tab === id ? "text-foreground" : "text-muted-foreground/60 hover:text-foreground"
                  )}
                  aria-pressed={tab === id}
                  onClick={() => setTab(id)}
                >
                  {label}
                </button>
              </React.Fragment>
            ))}
          </div>
        ) : (
          <span className="text-sm font-semibold tracking-tight">Subtitles</span>
        )}
      </div>

      {!hasCues ? (
        <EmptyState status={status} error={error} onGenerate={generate} onTranslate={translate} />
      ) : tab === "content" ? (
        <>
          {caps.transcribe && (
            <div className="shrink-0 px-1.5">
              <Button
                variant="ghost"
                size="sm"
                className="sub-regenerate"
                title="Transcribe the cut again (replaces these captions — undoable)"
                disabled={status === "running"}
                onClick={generate}
              >
                {status === "running" ? (
                  <Loader2 className="animate-spin" />
                ) : (
                  <RefreshCw />
                )}
                Regenerate
              </Button>
            </div>
          )}
          <Transcript cues={activeCues} />
          {status === "error" && error && (
            <p className="sub-error shrink-0 border-t border-border px-4 py-2.5 text-[11px] leading-relaxed text-red-600">
              {error}
            </p>
          )}
        </>
      ) : tab === "styles" ? (
        <StylesTab />
      ) : (
        <OptionsTab />
      )}
    </>
  );
}

/** The Options tab: caption visibility, the word effect the track plays with
 * its color, position reset for a dragged caption, and the subtitle-voiceover
 * generator. */
function OptionsTab() {
  const subtitles = useEditor((s) => s.subtitles);
  const moved =
    subtitles.x !== undefined ||
    subtitles.y !== undefined ||
    !!subtitles.tracks?.some((t) => t.x !== undefined || t.y !== undefined);
  // Effective word effect: the caption style's defaults with the user's
  // overrides on top, so the controls always show what's on the video.
  const words = captionWords(captionStyle(subtitles.style), subtitles);
  const on = !!subtitles.wordHighlight;
  const knobs = wordKnobs(wordEffect(words.style), {
    scale: subtitles.accentScale,
    dim: subtitles.accentDim,
  });

  return (
    <ScrollArea
      className="sub-options min-h-0 flex-1"
      contentClassName="flex flex-col gap-2.5 px-4 py-3"
    >
      <div className="mb-1 border-b border-border pb-3">
        <GenerateSubtitlesAudio />
      </div>
      <label className="flex min-h-8 items-center justify-between text-xs font-medium">
        Show subtitles
        <Switch
          className="sub-show"
          checked={subtitles.showOnVideo || subtitles.showOnTimeline}
          onCheckedChange={(v) => {
            const s = useEditor.getState();
            s.setSubtitlesView({ showOnVideo: v, showOnTimeline: v });
            if (v && s.timelineH < TIMELINE_H_WITH_SUBS) s.setTimelineH(TIMELINE_H_WITH_SUBS);
          }}
        />
      </label>
      <div className="flex min-h-8 items-center justify-between text-xs font-medium">
        Font
        <FontPicker
          className="sub-font w-28"
          value={subtitles.font ?? captionStyle(subtitles.style).font}
          onChange={(v) => useEditor.getState().setSubtitlesView({ font: v as FontId })}
        />
      </div>
      <div className="flex min-h-8 items-center justify-between text-xs font-medium">
        Size
        <div className="sub-size flex items-center gap-2">
          <ValueSlider
            label="Caption size"
            sliderClassName="data-horizontal:w-24"
            valueClassName="w-7 text-muted-foreground"
            value={subtitles.size ?? captionStyle(subtitles.style).size}
            min={24}
            max={120}
            step={1}
            snap={[captionStyle(subtitles.style).size]}
            format={(v) => String(Math.round(v))}
            parse={parseNumberInput}
            onDraft={(v) => useEditor.getState().setSubtitlesView({ size: v })}
            onCommit={(v) => useEditor.getState().setSubtitlesView({ size: v })}
          />
        </div>
      </div>
      <WordsPerCueRow />
      <div className="flex min-h-8 items-center justify-between text-xs font-medium">
        Word effect
        <PillSelect
          className="sub-word-highlight w-36"
          title="Word effect"
          value={on ? words.style : "none"}
          display={on ? wordEffect(words.style).label : "None"}
          options={[
            { value: "none", label: "None" },
            ...WORD_EFFECT_MENU.map((m) => ({ value: m.id, label: m.label })),
          ]}
          onChange={(v) =>
            useEditor.getState().setSubtitlesView(
              v === "none"
                ? { wordHighlight: undefined }
                : { wordHighlight: true, accentMode: v }
            )
          }
        />
      </div>
      {on && knobs.size && (
        <div className="flex min-h-8 items-center justify-between text-xs font-medium">
          Word size
          <div className="sub-accent-scale flex items-center gap-2">
            <ValueSlider
              label="Word size"
              sliderClassName="data-horizontal:w-24"
              valueClassName="w-9 text-muted-foreground"
              value={wordSwell(words)}
              min={WORD_SWELL_MIN}
              max={WORD_SWELL_MAX}
              step={0.02}
              snap={[1, WORD_POP_SCALE]}
              format={(v) => `${v.toFixed(2)}×`}
              parse={parseSpeedInput}
              onDraft={(v) => useEditor.getState().setSubtitlesView({ accentScale: v })}
              onCommit={(v) => useEditor.getState().setSubtitlesView({ accentScale: v })}
            />
          </div>
        </div>
      )}
      {on && knobs.dim && (
        <div className="flex min-h-8 items-center justify-between text-xs font-medium">
          Faded to
          <div className="sub-accent-dim flex items-center gap-2">
            <ValueSlider
              label="Faded to"
              sliderClassName="data-horizontal:w-24"
              valueClassName="w-9 text-muted-foreground"
              value={wordDim(words)}
              min={0}
              max={1}
              step={0.01}
              snap={[wordDim({ style: words.style })]}
              format={(v) => `${Math.round(v * 100)}%`}
              parse={parsePercentInput}
              onDraft={(v) => useEditor.getState().setSubtitlesView({ accentDim: v })}
              onCommit={(v) => useEditor.getState().setSubtitlesView({ accentDim: v })}
            />
          </div>
        </div>
      )}
      {on && knobs.color && (
        <div className="flex min-h-8 items-center justify-between text-xs font-medium">
          Word color
          <div className="sub-accent-color flex items-center">
            <ColorField
              value={wordAccent(words, captionStyle(subtitles.style).color)}
              label="Word color"
              onBegin={() => useEditor.getState().pushHistory()}
              onLive={(c) => useEditor.getState().setSubtitlesView({ accentColor: c })}
              onCommit={(c) => useEditor.getState().setSubtitlesView({ accentColor: c })}
            />
          </div>
        </div>
      )}
      <EmphasisRows />
      <div className="flex min-h-8 items-center justify-between text-xs font-medium">
        Position
        <Button
          variant="outline"
          size="sm"
          className="sub-position-reset"
          disabled={!moved}
          onClick={() => {
            const s = useEditor.getState();
            s.setSubtitlesView({ x: undefined, y: undefined });
            s.subtitles.tracks?.forEach((_, i) =>
              s.setSubtitleTrackMeta(i, { x: undefined, y: undefined })
            );
          }}
        >
          Reset
        </Button>
      </div>
      <p className="sub-position-hint -mt-1 text-[11px] leading-relaxed text-muted-foreground">
        Drag the caption on the video to reposition every subtitle.
      </p>
    </ScrollArea>
  );
}

/** The emphasis style: how the words set apart in the transcript look on the
 * video. The words themselves are picked in the Content tab. */
function EmphasisRows() {
  const subtitles = useEditor((s) => s.subtitles);
  const em = captionEmphasis(subtitles);
  const set = (patch: Parameters<ReturnType<typeof useEditor.getState>["setSubtitlesView"]>[0]) =>
    useEditor.getState().setSubtitlesView(patch);
  return (
    <div className="sub-emphasis mt-1 flex flex-col gap-2.5 border-t border-border pt-3">
      <div className="flex min-h-8 items-center justify-between text-xs font-medium">
        Emphasis font
        <FontPicker
          className="sub-emphasis-font w-28"
          value={em.font}
          onChange={(v) => {
            useEditor.getState().pushHistory();
            set({ emphasisFont: v as FontId });
          }}
        />
      </div>
      <div className="flex min-h-8 items-center justify-between text-xs font-medium">
        Emphasis color
        <div className="sub-emphasis-color flex items-center">
          <ColorField
            value={em.color}
            label="Emphasis color"
            onBegin={() => useEditor.getState().pushHistory()}
            onLive={(c) => set({ emphasisColor: c })}
            onCommit={(c) => set({ emphasisColor: c })}
          />
        </div>
      </div>
      <label className="flex min-h-8 items-center justify-between text-xs font-medium">
        Italic
        <Switch
          className="sub-emphasis-italic"
          checked={em.italic}
          onCheckedChange={(v) => {
            useEditor.getState().pushHistory();
            set({ emphasisItalic: v });
          }}
        />
      </label>
      <label className="flex min-h-8 items-center justify-between text-xs font-medium">
        Bold
        <Switch
          className="sub-emphasis-weight"
          checked={em.weight === 700}
          onCheckedChange={(v) => {
            useEditor.getState().pushHistory();
            set({ emphasisWeight: v ? 700 : 400 });
          }}
        />
      </label>
      <div className="flex min-h-8 items-center justify-between text-xs font-medium">
        Emphasis size
        <div className="sub-emphasis-scale flex items-center gap-2">
          <ValueSlider
            label="Emphasis size"
            sliderClassName="data-horizontal:w-24"
            valueClassName="w-9 text-muted-foreground"
            value={em.scale}
            min={EMPHASIS_SCALE_MIN}
            max={EMPHASIS_SCALE_MAX}
            step={0.02}
            snap={[1]}
            format={(v) => `${v.toFixed(2)}×`}
            parse={parseSpeedInput}
            onDraft={(v) => set({ emphasisScale: v })}
            onCommit={(v) => set({ emphasisScale: v })}
          />
        </div>
      </div>
      <p className="-mt-1 text-[11px] leading-relaxed text-muted-foreground">
        Right-click a word in the transcript, or put the cursor on it and press ⌘B, to set it
        apart in this style.
      </p>
    </div>
  );
}

/** How many words a caption holds at a time. Committing re-cuts every track
 * on its own words and measures the new captions against the cut's mix, which
 * takes a moment on a long project — the slider shows the drag, the track is
 * re-cut once on release. */
function WordsPerCueRow() {
  const subtitles = useEditor((s) => s.subtitles);
  const [draft, setDraft] = useState<number | null>(null);
  const [working, setWorking] = useState(false);
  const value = draft ?? cueWordCount(subtitles);
  return (
    <div className="flex min-h-8 items-center justify-between text-xs font-medium">
      Words at a time
      <div className="sub-words-per-cue flex items-center gap-2">
        {working && <Loader2 className="size-3 animate-spin text-muted-foreground" />}
        <ValueSlider
          label="Words at a time"
          sliderClassName="data-horizontal:w-24"
          valueClassName="w-7 text-muted-foreground"
          value={value}
          min={MIN_WORDS_PER_CUE}
          max={MAX_WORDS_PER_CUE}
          step={1}
          snap={[DEFAULT_WORDS_PER_CUE]}
          format={(v) => String(Math.round(v))}
          parse={parseNumberInput}
          onDraft={(v) => setDraft(Math.round(v))}
          onCommit={(v) => {
            setDraft(Math.round(v));
            setWorking(true);
            void useEditor
              .getState()
              .setSubtitleWordsPerCue(v)
              .finally(() => {
                setWorking(false);
                setDraft(null);
              });
          }}
        />
      </div>
    </div>
  );
}

/** The Styles tab: the caption style list, each option rendered as a live
 * preview of that look. */
function StylesTab() {
  const subtitles = useEditor((s) => s.subtitles);
  const style = subtitles.style ?? "clean";

  return (
    <ScrollArea
      className="sub-styles min-h-0 flex-1"
      contentClassName="flex flex-col gap-2.5 px-4 py-3"
    >
      <div className="flex flex-col gap-1.5">
        {Object.values(CAPTION_STYLES).map((cs) => (
          <button
            key={cs.id}
            className={cn(
              "sub-style rounded-lg p-1 text-left transition-colors",
              style === cs.id ? "bg-primary/10 ring-1 ring-primary" : "hover:bg-muted"
            )}
            aria-pressed={style === cs.id}
            // Picking a style hands the font back to the preset; the last
            // choice — custom font or style — wins.
            onClick={() => useEditor.getState().setSubtitlesView({ style: cs.id, font: undefined })}
          >
            <div className="grid h-12 place-items-center overflow-hidden rounded-md">
              <span
                className="whitespace-nowrap"
                style={{
                  fontSize: cs.size * 0.48,
                  fontFamily: fontStack(cs.font),
                  fontWeight: cs.weight,
                  color: cs.color,
                  // Heavier than the on-video shadow so white captions stay
                  // legible against the light panel.
                  textShadow: cs.shadow
                    ? "0 0 2px rgba(0,0,0,0.75), 0 1px 4px rgba(0,0,0,0.6)"
                    : undefined,
                  background: cs.plate ? plateFill(cs) : undefined,
                  padding: cs.plate ? `${PLATE_PAD_Y}em ${PLATE_PAD_X}em` : undefined,
                  borderRadius: cs.plate ? `${PLATE_RADIUS}em` : undefined,
                }}
              >
                Your caption
              </span>
            </div>
            <div className="px-1 pt-1 pb-0.5 text-[11px] font-medium">{cs.label}</div>
          </button>
        ))}
      </div>
    </ScrollArea>
  );
}

function EmptyState({
  status,
  error,
  onGenerate,
  onTranslate,
}: {
  status: string;
  error: string | null;
  onGenerate: () => void;
  onTranslate: (fromLane: number) => void;
}) {
  const caps = useCutCaps();
  const subtitles = useEditor((s) => s.subtitles);
  const lane = useEditor((s) => s.subtitleLane);
  const locale = trackLocale(subtitles, lane);
  // Other tracks that already have captions — each can seed this one by translation.
  const sources = Array.from({ length: subtitleLaneCount(subtitles) }, (_, i) => i).filter(
    (i) => i !== lane && laneCues(subtitles, i).length > 0
  );
  // Which pass is running, read from the store: this component unmounts
  // whenever the user visits another tab.
  const translating = useActiveWork("subtitles", "translate") > 0;

  if (status === "running") {
    return (
      <div className="sub-generating flex flex-col items-center gap-3 px-6 pt-10 text-center">
        <Loader2 className="size-5 animate-spin text-muted-foreground" />
        <p className="text-[13px] font-medium">
          {translating ? "Translating your captions…" : "Transcribing…"}{" "}
          <SubtitleElapsed />
        </p>
        <p className="text-[11.5px] leading-relaxed text-muted-foreground">
          Runs in the background — keep editing. Captions appear here when
          it finishes.
        </p>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-3 px-3.5">
      {status === "empty" && (
        <p className="sub-empty pt-1 text-[11.5px] leading-relaxed text-muted-foreground">
          No speech was found in this cut, so no subtitles were added to the
          video.
        </p>
      )}
      {status === "error" && error && (
        <div className="sub-error flex items-start gap-2 rounded-lg bg-red-50 px-3 py-2.5 text-[11.5px] leading-relaxed text-red-700">
          <AlertCircle className="mt-0.5 size-3.5 shrink-0" />
          {error}
        </div>
      )}
      <div className="relative">
        <select
          className="sub-locale w-full appearance-none rounded-lg border border-input bg-transparent py-2 pr-9 pl-2.5 text-[12.5px] outline-none focus:border-ring"
          value={locale}
          onChange={(e) => {
            const s = useEditor.getState();
            s.setSubtitleTrackMeta(s.subtitleLane, { locale: e.target.value });
          }}
        >
          {LOCALES.map(([id, label]) => (
            <option key={id} value={id}>
              {label}
            </option>
          ))}
        </select>
        <ChevronDown className="pointer-events-none absolute top-1/2 right-3 size-4 -translate-y-1/2 text-muted-foreground" />
      </div>
      {caps.transcribe && (
        <Button
          className="sub-generate w-full"
          onClick={onGenerate}
          title="Transcribe your audio into plain captions, word for word"
        >
          <Captions data-icon="inline-start" />
          {status === "empty" || status === "error" ? "Try again" : "Generate subtitles"}
        </Button>
      )}
      {caps.captionAi &&
        sources.map((i) => (
          <Button
            key={i}
            variant="outline"
            className="sub-translate w-full"
            title={`Write this track by translating the ${laneLanguage(subtitles, i)} captions into ${
              LOCALES.find(([id]) => id === locale)?.[1] ?? locale
            }`}
            onClick={() => onTranslate(i)}
          >
            <Languages data-icon="inline-start" />
            Translate from {laneLanguage(subtitles, i)}
          </Button>
        ))}
    </div>
  );
}

/** Opus-style flowing transcript: paragraphs of editable captions with
 * timestamp chips, plus pause chips where the speech leaves a gap. */
function Transcript({ cues }: { cues: SubtitleCue[] }) {
  // A pause over 2s starts a new paragraph; over 0.5s shows a pause chip.
  const paragraphs: { cue: SubtitleCue; gap: number }[][] = [];
  cues.forEach((cue, i) => {
    const gap = i === 0 ? 0 : cue.start - cues[i - 1].end;
    if (i === 0 || gap > 2) paragraphs.push([]);
    paragraphs[paragraphs.length - 1].push({ cue, gap });
  });

  return (
    <ScrollArea
      className="sub-transcript min-h-0 flex-1"
      contentClassName="select-text px-4 py-3"
    >
      {paragraphs.map((para) => (
        <p key={para[0].cue.id} className="mb-4 text-[12.5px] leading-[1.9]">
          {para.map(({ cue, gap }) => (
            <CueSpan key={cue.id} cue={cue} gap={gap} />
          ))}
        </p>
      ))}
    </ScrollArea>
  );
}

/** Characters from the start of `el` to a point inside it. */
function offsetIn(el: HTMLElement, node: Node, offset: number): number {
  const range = document.createRange();
  range.selectNodeContents(el);
  range.setEnd(node, offset);
  return range.toString().length;
}

/** The current selection as character offsets inside `el`, or null when it
 * lies elsewhere. */
function selectionIn(el: HTMLElement): [number, number] | null {
  const sel = window.getSelection();
  if (!sel || sel.rangeCount === 0) return null;
  const r = sel.getRangeAt(0);
  if (!el.contains(r.startContainer) || !el.contains(r.endContainer)) return null;
  return [offsetIn(el, r.startContainer, r.startOffset), offsetIn(el, r.endContainer, r.endOffset)];
}

/** The character offset inside `el` under a pointer, or null off its text. */
function pointIn(el: HTMLElement, x: number, y: number): number | null {
  let node: Node | null = null;
  let offset = 0;
  if ("caretPositionFromPoint" in document) {
    const p = document.caretPositionFromPoint(x, y);
    if (p) ({ offsetNode: node, offset } = p);
  } else if ("caretRangeFromPoint" in document) {
    const r = (document as Document).caretRangeFromPoint(x, y);
    if (r) ({ startContainer: node, startOffset: offset } = r);
  }
  return node && el.contains(node) ? offsetIn(el, node, offset) : null;
}

/** Put the selection back at character offsets inside `el`. */
function selectIn(el: HTMLElement, from: number, to: number) {
  const at = (target: number): [Node, number] => {
    const walk = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
    let left = target;
    let last: Text | null = null;
    for (let n = walk.nextNode() as Text | null; n; n = walk.nextNode() as Text | null) {
      if (left <= n.length) return [n, left];
      left -= n.length;
      last = n;
    }
    return last ? [last, last.length] : [el, 0];
  };
  const sel = window.getSelection();
  if (!sel) return;
  const range = document.createRange();
  range.setStart(...at(from));
  range.setEnd(...at(to));
  sel.removeAllRanges();
  sel.addRange(range);
}

/** Emphasized words in the transcript read set apart from the rest. */
const EM_CLASS = "sub-em rounded-[3px] bg-[#FFE94A]/70 font-semibold italic";

/** Fill the editable caption with its text, each emphasized word in a marked
 * span. Reading `textContent` back gives the text unchanged. */
function paintCue(el: HTMLElement, text: string, marked: readonly number[]) {
  el.replaceChildren(
    ...emphasisRuns(text, marked).map((run) => {
      if (!run.em) return document.createTextNode(run.text);
      const span = document.createElement("span");
      span.className = EM_CLASS;
      span.textContent = run.text;
      return span;
    })
  );
}

function caretOffset(el: HTMLElement): number {
  const sel = window.getSelection();
  if (!sel || sel.rangeCount === 0) return 0;
  const range = sel.getRangeAt(0).cloneRange();
  range.selectNodeContents(el);
  range.setEnd(sel.getRangeAt(0).endContainer, sel.getRangeAt(0).endOffset);
  return range.toString().length;
}

const CueSpan = memo(function CueSpan({ cue, gap }: { cue: SubtitleCue; gap: number }) {
  const active = usePreviewSelector((t) => t >= cue.start && t < cue.end);
  const readOnly = useEditor((s) => s.readOnly);
  const ref = useRef<HTMLSpanElement>(null);
  const [focused, setFocused] = useState(false);
  const [menu, setMenu] = useState<{
    x: number;
    y: number;
    from: number;
    to: number;
    label: string;
    on: boolean;
  } | null>(null);
  const marked = cueEmphasis(cue);
  const markKey = marked.join(",");

  // The span is uncontrolled while focused (so the caret survives typing);
  // outside edits (undo, regenerate, emphasis) sync the DOM here.
  useEffect(() => {
    const el = ref.current;
    if (el && document.activeElement !== el) paintCue(el, cue.text, markKey ? markKey.split(",").map(Number) : []);
  }, [cue.text, markKey]);

  /** The words a character range of the caption touches, and whether they
   * would all be emphasized by the toggle. Typing not yet committed is
   * committed first, so the words are the ones on screen. */
  const wordsAt = (from: number, to: number) => {
    const el = ref.current;
    if (!el) return null;
    const typed = el.textContent ?? "";
    const indices = wordIndicesIn(typed, from, to);
    if (indices.length === 0) return null;
    const words = typed.split(/\s+/).filter(Boolean);
    const set = new Set(marked);
    return {
      typed,
      indices,
      on: !indices.every((i) => set.has(i)),
      label: indices.map((i) => words[i]).join(" "),
    };
  };

  const toggle = (from: number, to: number) => {
    const el = ref.current;
    const hit = wordsAt(from, to);
    if (!el || !hit) return;
    const st = useEditor.getState();
    st.setCueText(cue.id, hit.typed);
    st.setCueEmphasis([{ id: cue.id, indices: hit.indices, on: hit.on }]);
    const live = useEditor.getState().subtitles.cues.find((c) => c.id === cue.id);
    // While the caption is being edited the effect above leaves it alone, so
    // the marks are painted here and the selection put back where it was.
    if (live && document.activeElement === el) {
      paintCue(el, hit.typed, cueEmphasis(live));
      selectIn(el, from, to);
    }
  };

  // Follow along during playback.
  useEffect(() => {
    if (active && useEditor.getState().playing)
      ref.current?.scrollIntoView({ block: "nearest", behavior: "smooth" });
  }, [active]);

  const commit = () => {
    setFocused(false);
    const el = ref.current;
    if (el) useEditor.getState().setCueText(cue.id, el.textContent ?? "");
  };

  return (
    <span className="sub-cue">
      {gap > 0.5 && (
        <span
          className="sub-gap mx-0.5 inline-block rounded-md bg-muted px-1.5 py-px align-baseline font-mono text-[10px] text-muted-foreground/80"
          title={`${gap.toFixed(1)}s pause`}
        >
          ·&thinsp;{gap.toFixed(1)}s&thinsp;·
        </span>
      )}
      <button
        className={cn(
          "sub-time mr-1 inline-block cursor-pointer rounded-md bg-muted px-1.5 py-px align-baseline font-mono text-[10px] tabular-nums text-muted-foreground transition-colors hover:bg-[#0a84ff]/15 hover:text-[#0a84ff]",
          active && "bg-[#0a84ff] text-white hover:bg-[#0a84ff] hover:text-white"
        )}
        title="Jump here"
        tabIndex={-1}
        onClick={() => useEditor.getState().seek(cue.start + 0.001)}
      >
        {fmtCueTime(cue.start)}
      </button>
      <span
        ref={ref}
        className={cn(
          "sub-text rounded-sm px-0.5 outline-none",
          active && "bg-[#0a84ff]/10",
          focused && "ring-1 ring-[#0a84ff]/40"
        )}
        contentEditable
        suppressContentEditableWarning
        spellCheck={false}
        data-cue={cue.id}
        onFocus={() => setFocused(true)}
        onBlur={commit}
        onContextMenu={(e) => {
          const el = ref.current;
          if (!el || readOnly) return;
          // A selection under the pointer names its words; otherwise the word
          // the pointer is on.
          const sel = selectionIn(el);
          const at = pointIn(el, e.clientX, e.clientY);
          const range: [number, number] | null =
            sel && sel[0] !== sel[1] && at !== null && at >= Math.min(...sel) && at <= Math.max(...sel)
              ? sel
              : at !== null
                ? [at, at]
                : null;
          const hit = range ? wordsAt(range[0], range[1]) : null;
          if (!range || !hit) return;
          e.preventDefault();
          e.stopPropagation();
          setMenu({ x: e.clientX, y: e.clientY, from: range[0], to: range[1], label: hit.label, on: hit.on });
        }}
        onKeyDown={(e) => {
          e.stopPropagation();
          const el = ref.current;
          if (!el) return;
          if ((e.metaKey || e.ctrlKey) && !e.altKey && !e.shiftKey && e.key.toLowerCase() === "b") {
            e.preventDefault();
            const sel = selectionIn(el);
            if (sel && !readOnly) toggle(sel[0], sel[1]);
            return;
          }
          if (e.key === "Escape") {
            e.preventDefault();
            el.blur();
          } else if (e.key === "Enter") {
            e.preventDefault();
            const off = caretOffset(el);
            // Blur first: it commits any typing (dropping stale word
            // timings), then the split uses whatever timing survives.
            el.blur();
            useEditor.getState().splitCue(cue.id, off);
          } else if (e.key === "Backspace" && caretOffset(el) === 0 && window.getSelection()?.isCollapsed) {
            e.preventDefault();
            el.blur(); // commit typing (or delete the cue if emptied)
            useEditor.getState().mergeCueIntoPrev(cue.id);
          }
        }}
      />{" "}
      {menu && (
        <DropdownMenu open onOpenChange={(o) => !o && setMenu(null)}>
          <DropdownMenuContent
            className="w-56"
            sideOffset={0}
            anchor={{ getBoundingClientRect: () => new DOMRect(menu.x, menu.y, 0, 0) }}
            finalFocus={false}
          >
            <DropdownMenuItem
              className="sub-emphasis-toggle"
              onClick={() => {
                toggle(menu.from, menu.to);
                setMenu(null);
              }}
            >
              <span className="truncate">
                {menu.on ? `Emphasize “${menu.label}”` : `Remove emphasis from “${menu.label}”`}
              </span>
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      )}
    </span>
  );
});
