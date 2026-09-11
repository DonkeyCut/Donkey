"use client";

import { useEffect, useRef, useState } from "react";
import {
  ALL_EFFECT_IDS,
  AUDIO_EFFECT_IDS,
  audioFxBars,
  EFFECT_LABELS,
  effectPreviewState,
  grainTileUrl,
  isAudioEffect,
  LEAK_TINT,
  leakGradient,
  streakGradient,
  type EffectId,
} from "@donkeycut/effects-kit";
import { ChevronLeft, ChevronRight, Pause, Play, Plus, Search, Star } from "lucide-react";
import { PHASE_STEP } from "@/cut/components/AnimationTiles";
import { PeakStrip } from "@/cut/components/AudioPanel";
import { PICKED_RING, pickGridNav, useAssetPick } from "@/cut/lib/assetPick";
import { useFxAudition } from "@/cut/lib/audioFxAudition";
import { clearElementDrag, setElementDragData, setObjectDragImage } from "@/cut/lib/assetDrag";
import { clearRefDrag, refFromStockSfx, setRefDragData } from "@/cut/lib/assetRef";
import { importStockAudio } from "@/cut/lib/media";
import { usePreviewAudio } from "@/cut/lib/previewAudio";
import { useRefCopy } from "@/cut/lib/refCopy";
import { useRevealEffect, useRevealFlash } from "@/cut/lib/refReveal";
import { useSoundFavorites } from "@/cut/lib/soundFavorites";
import { SubTabs } from "@/cut/components/SubTabs";
import { usePlayheadFrame } from "@/cut/components/usePlayheadFrame";
import { STOCK_SFX_CATEGORIES, stockTitle, type StockSfx, type StockSfxCategory } from "@/cut/lib/stock";
import { STOCK_SFX } from "@/cut/lib/stockSfxManifest";
import { useEditor } from "@/cut/lib/store";
import { isEffectOverlay, TRANSITION_STYLE_LABELS, type EffectOverlay } from "@/cut/lib/types";
import { useLocalPref } from "@/cut/lib/uiState";
import { cn } from "@/lib/utils";
import { Input } from "@/components/ui/input";
import { ScrollArea } from "@/components/ui/scroll-area";
import "./grain.css";

/**
 * The Effects tab: time-ranged treatments over the finished cut. A segmented
 * toggle splits the grid into three families: Moving, the effects that play
 * over their stretch of timeline (zoom, grain, VHS, glitch, light leak, flash,
 * shake), Filters, the still treatments and graded looks (blur, vignette,
 * vintage, noir, halation…), and Sound, everything done to the audio — the
 * treatments over the window (echo, reverb, muffle, telephone…) and the
 * handover that dissolves the sound across a cut. Drag one onto the timeline
 * to place it; a click only picks the tile, the same as every other panel.
 * Under the treatments sits the sound-effect shelf: the bundled one-shots
 * (whooshes, clicks, risers, hits…) that drop onto the soundtrack as audio
 * clips.
 *
 * The picture effects treat the footage and everything laid over it; the audio
 * ones treat everything audible under them — clip sound, upper tracks and the
 * soundtrack, mixed. The sound tiles are cards with a play control, because a
 * treatment on the sound is picked by ear: pressing one plays a spoken line
 * through it, and the dissolve plays two voices crossing at a cut. The sound
 * dissolve is a transition, so it lands on a cut rather than over a stretch,
 * and the styles that blend the picture stay in the Transitions tab.
 *
 * Select an effect on the timeline and the tab follows it: its family opens,
 * its tile is the marked one, and a click on another tile changes that
 * element to it. The click never places anything — with an effect selected
 * it retunes what is already there, and with nothing selected it just picks.
 */

type EffectGroup = "moving" | "filters" | "audio";

/** The transition that hands over on the sound alone, picked from this shelf
 * rather than the Transitions tab: what it does, it does to the sound. */
const CROSS_DISSOLVE = "audiocross" as const;

const GROUPS = [
  { id: "moving", label: "Moving" },
  { id: "filters", label: "Filters" },
  // "Sound", because the rail's own Audio tab is where music and voiceover
  // live; this family is the treatments over whatever is already audible.
  { id: "audio", label: "Sound" },
] as const;

const MOVING: EffectId[] = ["zoom", "grain", "vhs", "glitch", "lightleak", "flash", "shake"];

const groupOf = (id: EffectId): EffectGroup =>
  isAudioEffect(id) ? "audio" : MOVING.includes(id) ? "moving" : "filters";

export function EffectsPanel() {
  const live = useEditor((s) => {
    if (s.selection?.kind !== "overlay") return null;
    const o = s.overlays.find((x) => x.id === s.selection!.id);
    return o && isEffectOverlay(o) ? o : null;
  });
  const [group, setGroup] = useLocalPref<EffectGroup>("cut-effects-group", "moving", (v) =>
    GROUPS.some((g) => g.id === v)
  );
  // The Sound family drills down: the root lists the sound groups, and an
  // open group replaces the segmented control with a back header. Kept across
  // reloads like the group itself.
  const [soundGroup, setSoundGroup] = useLocalPref<SoundGroup | null>(
    "cut-effects-sound-group",
    null,
    (v) =>
      v === null ||
      v === FAVORITES ||
      v === TREATMENTS ||
      (STOCK_SFX_CATEGORIES as readonly string[]).includes(String(v))
  );
  // The tab follows the selection into its family so the marked tile shows.
  const liveEffect = live?.effect;
  useEffect(() => {
    if (!liveEffect) return;
    setGroup(groupOf(liveEffect));
    if (isAudioEffect(liveEffect)) setSoundGroup(TREATMENTS);
  }, [liveEffect, setGroup, setSoundGroup]);
  // A sound-effect reference clicked in the chat lands on its card: the family
  // opens here, its group opens below, and the card scrolls into view.
  useRevealEffect((ref) => {
    const hit = ref.scope === "stock" ? STOCK_SFX.find((x) => x.id === ref.id) : undefined;
    if (!hit) return;
    setGroup("audio");
    setSoundGroup(hit.category);
  });
  const frame = usePlayheadFrame();
  // An audition belongs to the panel that started it; leaving the tab, or the
  // panel, silences it.
  useEffect(() => () => silence(), [group]);
  return (
    <>
      {/* PanelHead's height, so the side panel's floating close button lands
          on the toggle's centerline; the right padding keeps clear of it. */}
      <div className="flex h-12 shrink-0 items-center pr-12 pl-3.5">
        {group === "audio" && soundGroup ? (
          <div className="flex min-w-0 items-center gap-1">
            <button
              type="button"
              onClick={() => {
                silence();
                setSoundGroup(null);
              }}
              className="flex h-8 items-center gap-0.5 rounded-full pr-2.5 pl-1.5 text-[13px] font-medium text-muted-foreground hover:bg-muted hover:text-foreground"
            >
              <ChevronLeft className="size-4" />
              Sounds
            </button>
            <span className="truncate text-[13px] font-semibold tracking-tight">{soundGroup}</span>
          </div>
        ) : (
          <SubTabs tabs={GROUPS} value={group} onChange={setGroup} />
        )}
      </div>

      {/* The top pad is the selected tile's ring and its offset: the grid
          starts at the scroll edge, and a ring drawn outside the tile would be
          cut off there. */}
      {group === "audio" ? (
        <SoundShelf live={live} open={soundGroup} onOpen={setSoundGroup} />
      ) : (
        <ScrollArea className="min-h-0 flex-1" contentClassName="px-3.5 pt-1 pb-4">
          <div className="grid grid-cols-2 gap-2" onKeyDown={pickGridNav}>
            {ALL_EFFECT_IDS.filter((id) => groupOf(id) === group).map((id) => (
              <EffectTile key={id} id={id} live={live} frame={frame} />
            ))}
          </div>
        </ScrollArea>
      )}
    </>
  );
}

/** One effect: the preview fills the tile with its name under it, a click
 * picks it (or swaps the selected element to it), and a drag onto the timeline
 * places it. Hovering runs the preview — the flash pulses, the glitch tears,
 * the shake moves. */
function EffectTile({
  id,
  live,
  frame,
}: {
  id: EffectId;
  live: EffectOverlay | null;
  frame: string | null;
}) {
  const { picked, pick } = useAssetPick(`effect:${id}`);
  const [hover, setHover] = useState(false);
  // A moving effect's whole point is its motion, so its swatch always plays,
  // and an audio figure is motion by nature; a filter swatch stands still
  // until the pointer asks it to run. The leak's motion is a slow continuous
  // wander — the shared 1.4s loop samples a sliver of it and snaps back, so
  // its clock never wraps and the bloom just roams.
  const t = useSwatchClock(hover || groupOf(id) !== "filters", id === "lightleak" ? Infinity : LOOP_S);
  const ref = useRef<HTMLButtonElement>(null);
  // What the selection means for this tile: it wears the ring when it is the
  // selected element's effect, and a click swaps that element onto it.
  const isLive = live?.effect === id;
  const marked = live ? isLive : picked;
  useEffect(() => {
    // Selecting an effect far down the list brings its tile into view.
    if (isLive) ref.current?.scrollIntoView({ block: "nearest" });
  }, [isLive]);
  const tile = (
    <button
      ref={ref}
      type="button"
      data-pick-id={`effect:${id}`}
      aria-pressed={marked}
      draggable
      onDragStart={(e) => {
        setElementDragData(e, { kind: "effect", effect: id });
        setObjectDragImage(e);
      }}
      onDragEnd={clearElementDrag}
      onPointerEnter={() => setHover(true)}
      onPointerLeave={() => setHover(false)}
      onFocus={() => setHover(true)}
      onBlur={() => setHover(false)}
      onClick={() => {
        if (!live) return pick();
        if (!isLive) useEditor.getState().updateOverlay(live.id, { effect: id });
      }}
      // Scroll margin keeps the whole tile — selection ring included — clear
      // of the scroller's edges when scrollIntoView lands it there. The picked
      // ring is the focus indicator; the browser outline stays off.
      className="flex scroll-m-2 flex-col gap-1.5 text-[11px] font-medium text-muted-foreground outline-none transition-colors hover:text-foreground"
    >
      <EffectSwatch
        id={id}
        t={t}
        frame={frame}
        className={cn("w-full rounded-lg border border-border", marked && PICKED_RING)}
      />
      <span className="leading-none">{EFFECT_LABELS[id]}</span>
    </button>
  );
  return tile;
}

/**
 * One treatment on the sound, as the card the stock audio shelves use: the
 * figure across the middle, the play control on it, the name laid over the
 * bottom edge. A sound tile is picked by ear, so it carries the same play
 * affordance a music sample does; the card itself picks and drags like every
 * other tile.
 */
function SoundTile({
  id,
  live,
  index,
}: {
  id: EffectId;
  live: EffectOverlay | null;
  index: number;
}) {
  const { picked, pick } = useAssetPick(`effect:${id}`);
  const t = useSoundClock(index);
  const ref = useRef<HTMLDivElement | null>(null);
  const isLive = live?.effect === id;
  const marked = live ? isLive : picked;
  useEffect(() => {
    if (isLive) ref.current?.scrollIntoView({ block: "nearest" });
  }, [isLive]);
  const choose = () => {
    if (!live) return pick();
    if (!isLive) useEditor.getState().updateOverlay(live.id, { effect: id });
  };
  const playing = useFxAudition((s) => s.effect === id);
  return (
    <SoundCard
      cardRef={(el) => {
        ref.current = el;
      }}
      pickId={`effect:${id}`}
      label={EFFECT_LABELS[id]}
      marked={marked}
      onChoose={choose}
      onDragStart={(e) => {
        setElementDragData(e, { kind: "effect", effect: id });
        setObjectDragImage(e);
      }}
      onDragEnd={clearElementDrag}
      figure={<BarStrip bars={audioFxBars(id, t, STRIP_BARS, 0.9)} />}
      playing={playing}
      onTogglePlay={() => useFxAudition.getState().toggle(id)}
    />
  );
}

/**
 * The handover on the sound: the picture cuts and the sound crosses it.
 *
 * It is a transition rather than an effect element — it drags onto a cut, and
 * the timeline marks the joint it would take — but it belongs on this shelf,
 * because what it does is done to the sound.
 */
function CrossDissolveTile({ index }: { index: number }) {
  const { picked, pick } = useAssetPick(`transition:${CROSS_DISSOLVE}`);
  const t = useSoundClock(index);
  const playing = useFxAudition((s) => s.effect === CROSS_DISSOLVE);
  return (
    <SoundCard
      pickId={`transition:${CROSS_DISSOLVE}`}
      label={TRANSITION_STYLE_LABELS[CROSS_DISSOLVE]}
      marked={picked}
      onChoose={pick}
      onDragStart={(e) => {
        setElementDragData(e, { kind: "transition", style: CROSS_DISSOLVE });
        setObjectDragImage(e);
      }}
      onDragEnd={clearElementDrag}
      figure={<CrossStrip t={t} />}
      playing={playing}
      onTogglePlay={() => useFxAudition.getState().toggle(CROSS_DISSOLVE)}
    />
  );
}

/** Quiets every sound the panel can be playing: a treatment audition and a
 * catalog preview. Leaving a view takes its sound with it. */
function silence() {
  useFxAudition.getState().stop();
  usePreviewAudio.getState().stop();
}

/** The card the sound shelf is built from: figure, play control, name, and
 * whatever a shelf lays in the corners (a duration, an add button). */
function SoundCard({
  cardRef,
  pickId,
  label,
  marked,
  flash,
  onChoose,
  onDragStart,
  onDragEnd,
  figure,
  playing,
  onTogglePlay,
  corner,
  trailing,
}: {
  cardRef?: (el: HTMLDivElement | null) => void;
  pickId: string;
  label: string;
  marked: boolean;
  /** The reveal highlight — a reference to this card was clicked in chat. */
  flash?: boolean;
  onChoose: () => void;
  onDragStart: (e: React.DragEvent) => void;
  onDragEnd: () => void;
  figure: React.ReactNode;
  playing: boolean;
  onTogglePlay: () => void;
  /** Extra controls laid over the card beside the play button. */
  corner?: React.ReactNode;
  /** A small note at the end of the name row (a length); the name truncates
   * before it. */
  trailing?: React.ReactNode;
}) {
  return (
    // The play control sits over the card as a sibling rather than inside it:
    // the card is what a drag carries, and the ghost of it is the boxed
    // waveform — pressing play is not part of what is dragged.
    <span className="group relative block">
      <div
        ref={cardRef}
        data-pick-id={pickId}
        data-drag-object
        role="button"
        tabIndex={0}
        aria-pressed={marked}
        draggable
        onDragStart={onDragStart}
        onDragEnd={onDragEnd}
        onClick={onChoose}
        onKeyDown={(e) => {
          if (e.key === "Enter" || e.key === " ") {
            e.preventDefault();
            onChoose();
          }
        }}
        className={cn(
          "flex scroll-m-2 cursor-grab flex-col overflow-hidden rounded-xl border border-border bg-muted/40 outline-none",
          (marked || flash) && PICKED_RING
        )}
      >
        <div className="relative h-16">
          <span className="absolute inset-x-2.5 top-2.5 block">{figure}</span>
          <span
            data-drag-omit
            className="absolute inset-x-2.5 bottom-1.5 flex items-baseline gap-1.5 text-[11.5px] leading-tight font-medium"
          >
            <span className="min-w-0 flex-1 truncate" title={label}>
              {label}
            </span>
            {trailing}
          </span>
        </div>
      </div>
      <button
        type="button"
        title={playing ? "Stop" : "Play"}
        aria-label={`${playing ? "Stop" : "Play"} ${label}`}
        onClick={onTogglePlay}
        className="absolute top-1.5 left-1.5 grid size-6 place-items-center rounded-full bg-background text-foreground shadow-sm ring-1 ring-border transition-transform hover:scale-105"
      >
        {playing ? <Pause className="size-3" /> : <Play className="size-3 translate-x-px" />}
      </button>
      {corner}
    </span>
  );
}

/** The card's name drops the family the header already gives: "whoosh-quick"
 * under Whoosh reads "Quick". */
const sfxName = (s: StockSfx) => {
  const family = s.category.toLowerCase().replace(/[^a-z0-9]+/g, "-");
  return stockTitle(s.id.startsWith(`${family}-`) ? s.id.slice(family.length + 1) : s.id);
};

/** How many matches a search shows at once. */
const SFX_SEARCH_LIMIT = 60;

/** The two groups of the shelf's own: the starred sounds, and the treatments,
 * listed with the sound families. */
const FAVORITES = "Favorites";
const TREATMENTS = "Treatments";
type SoundGroup = typeof FAVORITES | typeof TREATMENTS | StockSfxCategory;

/**
 * The Sound family's shelf. The root is a search box over a list of groups —
 * the starred sounds, the treatments, then every sound family with its count
 * — and opening
 * a group pushes its grid, with the panel header turning into "‹ Sounds" so
 * the way back is one tap. A search shows whatever matches, treatments
 * included, grouped under their family names.
 */
function SoundShelf({
  live,
  open,
  onOpen,
}: {
  live: EffectOverlay | null;
  open: SoundGroup | null;
  onOpen: (g: SoundGroup | null) => void;
}) {
  const [query, setQuery] = useState("");
  const favoriteIds = useSoundFavorites((s) => s.ids);
  const families = STOCK_SFX_CATEGORIES.filter((c) => STOCK_SFX.some((x) => x.category === c));
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  const matchesWords = (hay: string) => words.every((w) => hay.includes(w));

  const treatmentGrid = (ids: readonly EffectId[], dissolve: boolean) => (
    <div className="grid grid-cols-2 gap-2 pt-1" onKeyDown={pickGridNav}>
      {ids.map((id, i) => (
        <SoundTile key={id} id={id} live={live} index={i} />
      ))}
      {/* The handover on the sound sits with the treatments on the sound. It
          is a transition — it drags to a cut, where the picture keeps cutting
          and the sound crosses over. */}
      {dissolve && <CrossDissolveTile index={AUDIO_EFFECT_IDS.length} />}
    </div>
  );
  const soundGrid = (items: StockSfx[], fullNames = false) => (
    <div className="grid grid-cols-2 gap-2 pt-1" onKeyDown={pickGridNav}>
      {items.map((x) => (
        <SfxCard key={x.id} sound={x} fullName={fullNames} />
      ))}
    </div>
  );

  // An open group: just its cards.
  if (open === FAVORITES) {
    const items = favoriteIds
      .map((id) => STOCK_SFX.find((x) => x.id === id))
      .filter((x): x is StockSfx => x !== undefined);
    return (
      <ScrollArea className="min-h-0 flex-1" contentClassName="px-3.5 pt-1 pb-4">
        {/* Favorites come from every family, so each card carries its own. */}
        {items.length > 0 ? (
          soundGrid(items, true)
        ) : (
          <div className="py-2 text-[12px] text-muted-foreground">
            Star a sound to keep it here.
          </div>
        )}
      </ScrollArea>
    );
  }
  if (open === TREATMENTS) {
    return (
      <ScrollArea className="min-h-0 flex-1" contentClassName="px-3.5 pt-1 pb-4">
        {treatmentGrid(AUDIO_EFFECT_IDS, true)}
      </ScrollArea>
    );
  }
  if (open) {
    return (
      <ScrollArea className="min-h-0 flex-1" contentClassName="px-3.5 pt-1 pb-4">
        {soundGrid(STOCK_SFX.filter((x) => x.category === open))}
      </ScrollArea>
    );
  }

  let body: React.ReactNode;
  if (words.length > 0) {
    const ids = AUDIO_EFFECT_IDS.filter((id) => matchesWords(EFFECT_LABELS[id].toLowerCase()));
    const dissolve = matchesWords(TRANSITION_STYLE_LABELS[CROSS_DISSOLVE].toLowerCase());
    const hits = STOCK_SFX.filter((x) =>
      matchesWords([x.id, x.category, x.prompt, ...x.tags].join(" ").toLowerCase())
    ).slice(0, SFX_SEARCH_LIMIT);
    const sections = families
      .map((c) => ({ c, items: hits.filter((x) => x.category === c) }))
      .filter(({ items }) => items.length > 0);
    body =
      ids.length === 0 && !dissolve && hits.length === 0 ? (
        <div className="py-2 text-[12px] text-muted-foreground">No sounds match.</div>
      ) : (
        <>
          {(ids.length > 0 || dissolve) && (
            <Section title={TREATMENTS}>{treatmentGrid(ids, dissolve)}</Section>
          )}
          {sections.map(({ c, items }) => (
            <Section key={c} title={c}>
              {soundGrid(items)}
            </Section>
          ))}
        </>
      );
  } else {
    const rows: { group: SoundGroup; count: number }[] = [
      { group: FAVORITES, count: favoriteIds.length },
      { group: TREATMENTS, count: AUDIO_EFFECT_IDS.length + 1 },
      ...families.map((c) => ({ group: c, count: STOCK_SFX.filter((x) => x.category === c).length })),
    ];
    body = (
      <div className="flex flex-col">
        {rows.map((r) => (
          <button
            key={r.group}
            type="button"
            onClick={() => onOpen(r.group)}
            // The hover pad hangs outside the row, so the name sits on the
            // search field's left edge and the chevron on its right.
            className="-mx-2 flex h-9 items-center gap-2 rounded-lg px-2 text-[12.5px] font-medium hover:bg-muted"
          >
            <span className="flex-1 truncate text-left">{r.group}</span>
            <span className="font-mono text-[10px] text-muted-foreground tabular-nums">{r.count}</span>
            <ChevronRight className="size-3.5 text-muted-foreground" />
          </button>
        ))}
      </div>
    );
  }

  return (
    <>
      <div className="shrink-0 px-3.5 pb-3">
        <div className="relative">
          <Search className="pointer-events-none absolute top-1/2 left-2.5 size-3.5 -translate-y-1/2 text-muted-foreground" />
          <Input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search sounds"
            aria-label="Search sounds"
            className="h-8 pl-8 text-[12px]"
          />
        </div>
      </div>
      <ScrollArea className="min-h-0 flex-1" contentClassName="flex flex-col gap-4 px-3.5 pt-1 pb-4">
        {body}
      </ScrollArea>
    </>
  );
}

/** A family's heading over its cards in the search results. */
function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="flex flex-col gap-1">
      <span className="text-[12px] font-semibold tracking-tight">{title}</span>
      {children}
    </div>
  );
}

/** One sound effect: the same card as the treatments, with its real waveform,
 * its length in the corner, and a "+" that drops it at the playhead. Picking
 * a sound plays it — by click or by arrowing onto it — so a run through the
 * list is heard; picking it again stops it. */
function SfxCard({ sound, fullName = false }: { sound: StockSfx; fullName?: boolean }) {
  const pickId = `stock:${sound.id}`;
  const { picked, pick } = useAssetPick(pickId);
  const projectId = useEditor((s) => s.projectId);
  const playing = usePreviewAudio((s) => s.url === sound.file);
  const { flash, attachReveal } = useRevealFlash("stock", sound.id);
  const copyRef = useRefCopy(() => [refFromStockSfx(sound)]);
  const starred = useSoundFavorites((s) => s.ids.includes(sound.id));
  const label = fullName ? stockTitle(sound.id) : sfxName(sound);
  const choose = () => {
    pick();
    const preview = usePreviewAudio.getState();
    if (picked) preview.stop(sound.file);
    else if (preview.url !== sound.file) preview.toggle(sound.file);
  };
  const add = () => {
    if (!projectId) return;
    void importStockAudio(projectId, { url: sound.file, name: stockTitle(sound.id), duration: sound.duration })
      .then((a) => useEditor.getState().addAssetAtPlayhead(a.id))
      .catch(() => {});
  };
  return (
    <SoundCard
      cardRef={(el) => {
        attachReveal(el);
        copyRef(el);
      }}
      pickId={pickId}
      label={label}
      marked={picked}
      flash={flash}
      onChoose={choose}
      onDragStart={(e) => {
        setRefDragData(e, refFromStockSfx(sound));
        setObjectDragImage(e);
      }}
      onDragEnd={clearRefDrag}
      figure={<PeakStrip peaks={sound.peaks} className="mt-0 h-7 text-muted-foreground/70" />}
      playing={playing}
      onTogglePlay={() => usePreviewAudio.getState().toggle(sound.file)}
      trailing={
        // The add button lands on the length while the card is hovered.
        <span className="shrink-0 font-mono text-[9px] text-muted-foreground tabular-nums transition-opacity group-hover:opacity-0">
          {sound.duration.toFixed(1)}s
        </span>
      }
      corner={
        <>
          <button
            type="button"
            title="Add at the playhead"
            aria-label={`Add ${label} at the playhead`}
            onClick={add}
            className="absolute right-1.5 bottom-1.5 grid size-6 place-items-center rounded-full bg-background text-foreground opacity-0 shadow-sm ring-1 ring-border transition-opacity group-hover:opacity-100 hover:scale-105"
          >
            <Plus className="size-3" />
          </button>
          {/* The star stays once set; unstarred it shows on hover, so a card
              that is not a favorite reads clean. */}
          <button
            type="button"
            title={starred ? "Remove from favorites" : "Add to favorites"}
            aria-label={`${starred ? "Remove" : "Add"} ${label} ${starred ? "from" : "to"} favorites`}
            aria-pressed={starred}
            onClick={() => useSoundFavorites.getState().toggle(sound.id)}
            className={cn(
              "absolute top-1.5 right-1.5 grid size-6 place-items-center rounded-full bg-background text-foreground shadow-sm ring-1 ring-border transition-opacity hover:scale-105",
              starred ? "opacity-100" : "opacity-0 group-hover:opacity-100"
            )}
          >
            <Star className={cn("size-3", starred && "fill-current")} />
          </button>
        </>
      }
    />
  );
}

/** Seconds into the effect the preview stands at: still at rest, running while
 * the tile is hovered so the time-varying effects show what they do. */
const SWATCH_T = 0.12; // seconds in — past a flash's white peak
const LOOP_S = 1.4;

/** One frame callback for every swatch on screen. A tab holds a dozen-odd
 * tiles, and a rAF each would be a dozen wake-ups a frame competing with the
 * preview for the same main thread; they all read this clock instead, so the
 * cost of a running tab is one callback and one batched render. */
const swatchClock = {
  now: 0,
  raf: 0,
  from: 0,
  readers: new Set<() => void>(),
  step(t: number) {
    if (!swatchClock.from) swatchClock.from = t;
    swatchClock.now = (t - swatchClock.from) / 1000;
    for (const read of swatchClock.readers) read();
    swatchClock.raf = requestAnimationFrame(swatchClock.step);
  },
  join(read: () => void) {
    swatchClock.readers.add(read);
    if (!swatchClock.raf) swatchClock.raf = requestAnimationFrame(swatchClock.step);
    return () => {
      swatchClock.readers.delete(read);
      if (swatchClock.readers.size === 0) {
        cancelAnimationFrame(swatchClock.raf);
        swatchClock.raf = 0;
        swatchClock.from = 0;
        swatchClock.now = 0;
      }
    };
  },
};

/** A looping clock for tile previews, shared with the Transitions tab. A
 * `resetKey` change starts the loop over from the top. Swatches stand still
 * while the cut is playing: the picture is what the frames are for then. */
export function useSwatchClock(running: boolean, loop = LOOP_S, resetKey = 0): number {
  const playing = useEditor((s) => s.playing);
  const [t, setT] = useState(SWATCH_T);
  const live = running && !playing;
  useEffect(() => {
    if (!live) return;
    const from = swatchClock.now;
    const leave = swatchClock.join(() => setT((swatchClock.now - from) % loop));
    // Back to the resting frame as the pointer leaves.
    return () => {
      leave();
      setT(SWATCH_T);
    };
  }, [live, loop, resetKey]);
  return t;
}

/** The picture a swatch treats: the given frame when there is one, scaled at
 * its own aspect to cover the square tile, and a small colored landscape as
 * the stand-in, so every treatment reads at tile size. The stand-in comes in
 * two casts — day (sun over green hills) and dusk (moon over dark ones) — so
 * a transition tile can hand over between two scenes that read as different
 * shots. Shared with the Transitions tab. */
export function SwatchScene({
  frame,
  variant = "day",
}: {
  frame: string | null;
  variant?: "day" | "dusk";
}) {
  if (frame) {
    return (
      // eslint-disable-next-line @next/next/no-img-element -- a transient data URL or filmstrip thumb; the image optimizer has no role
      <img src={frame} alt="" draggable={false} className="absolute inset-0 size-full object-cover" />
    );
  }
  if (variant === "dusk") {
    return (
      <>
        <span className="absolute inset-0 bg-[linear-gradient(165deg,#2b3f77_0%,#5a4a8a_55%,#c26d4a_100%)]" />
        <span className="absolute top-[14%] right-[16%] aspect-square w-[15%] rounded-full bg-[#f3ead0]" />
        <svg
          viewBox="0 0 100 56"
          aria-hidden
          className="absolute inset-x-0 bottom-0 h-[56%] w-full"
        >
          <polygon points="0,56 30,8 60,56" fill="#17293c" />
          <polygon points="38,56 70,22 100,52 100,56" fill="#1f3a4d" />
        </svg>
      </>
    );
  }
  return (
    <>
      <span className="absolute inset-0 bg-[linear-gradient(165deg,#6ea8f5_0%,#a97ee0_55%,#f0a12e_100%)]" />
      <span className="absolute top-[12%] left-[14%] aspect-square w-[22%] rounded-full bg-[#fdf0c2]" />
      <svg
        viewBox="0 0 100 56"
        aria-hidden
        className="absolute inset-x-0 bottom-0 h-[56%] w-full"
      >
        <polygon points="0,56 30,8 60,56" fill="#255c3f" />
        <polygon points="38,56 70,22 100,52 100,56" fill="#3a7a52" />
      </svg>
    </>
  );
}

/**
 * What an audio effect does to the sound: the bar figure its recipe shapes,
 * rolling on the shared swatch clock.
 *
 * The figure comes off the same recipe the mix is built from — a delay tap
 * shows as its repeat, a low pass rounds the bars off, a wobble swings them —
 * so a tile can only show what the effect actually does. The geometry is the
 * waveform strip the audio shelves draw, so a treatment and a piece of music
 * read as the same kind of thing.
 */
const STRIP_BARS = 40;

function BarStrip({
  bars,
  alphaAt,
  className,
}: {
  bars: number[];
  /** Per-bar opacity, for a figure that crosses rather than one that plays. */
  alphaAt?: (i: number, n: number) => number;
  className?: string;
}) {
  return (
    <svg
      viewBox={`0 0 ${bars.length * 2} 16`}
      preserveAspectRatio="none"
      aria-hidden
      className={cn("block h-7 w-full text-muted-foreground/70", className)}
    >
      {bars.map((v, i) => {
        const h = Math.max(1.5, Math.min(1, v) * 16);
        return (
          <rect
            key={i}
            x={i * 2}
            y={(16 - h) / 2}
            width={1.2}
            height={h}
            rx={0.6}
            fill="currentColor"
            fillOpacity={alphaAt ? alphaAt(i, bars.length) : undefined}
          />
        );
      })}
    </svg>
  );
}

/**
 * The clock one sound tile's figure runs on.
 *
 * The figures roll rather than loop, so nothing on the shelf has to snap back
 * to a start — and each tile is handed its own place in the roll and its own
 * slightly different rate, a golden-ratio step by its position in the grid, so
 * the shelf never moves in formation and never falls back into it.
 */
function useSoundClock(index: number): number {
  const now = useSwatchClock(true, Infinity);
  const phase = ((index * PHASE_STEP) % 1) * 4;
  const rate = 0.8 + ((index * PHASE_STEP * 3) % 1) * 0.45;
  return (now + phase) * rate;
}

/** The cross dissolve's figure: one sound going as the other arrives, with the
 * cut standing where the picture changes.
 *
 * Each side is scaled by its own ramp rather than only faded, because that is
 * what the effect does to it — the outgoing sound is smaller as it reaches the
 * cut, the incoming one grows out of it — and a level is what reads at tile
 * size. */
function CrossStrip({ t }: { t: number }) {
  // The ramps are the equal-power pair the crossing really uses: both sides
  // are still up at the cut, each at about seven tenths, so the figure crosses
  // in the middle rather than pinching to nothing there.
  const going = (i: number, n: number) => Math.cos(((i / (n - 1)) * Math.PI) / 2);
  const coming = (i: number, n: number) => Math.sin(((i / (n - 1)) * Math.PI) / 2);
  const scaled = (bars: number[], at: (i: number, n: number) => number) =>
    bars.map((v, i) => v * at(i, bars.length));
  const outgoing = audioFxBars(null, t, STRIP_BARS);
  const incoming = audioFxBars(null, t + 1.7, STRIP_BARS);
  return (
    <span className="relative block h-7">
      <BarStrip
        bars={scaled(outgoing, going)}
        alphaAt={(i, n) => 0.35 + 0.65 * going(i, n)}
        className="absolute inset-0"
      />
      <BarStrip
        bars={scaled(incoming, coming)}
        alphaAt={(i, n) => 0.35 + 0.65 * coming(i, n)}
        className="absolute inset-0"
      />
      <span className="absolute inset-y-0 left-1/2 w-px -translate-x-1/2 bg-foreground/40" />
    </span>
  );
}

/** What an effect does to the picture: the same preview state the canvas pass
 * reads, applied over the swatch scene. */
export function EffectSwatch({
  id,
  t = SWATCH_T,
  frame = null,
  className,
}: {
  id: EffectId;
  t?: number;
  /** The frame under the playhead as a data URL; null shows the stand-in. */
  frame?: string | null;
  className?: string;
}) {
  // The leak wanders at a pace tuned to a clip's seconds; the tile doubles its
  // clock so the roaming reads without a long watch.
  const st = effectPreviewState(id, 0.9, id === "lightleak" ? t * 2 : t);
  const grainUrl = grainTileUrl();
  const wash = st.washes?.[0];
  // Filter blur radii are design px against the full frame; the swatch is a
  // small fraction of one, so the same radius smears it to a wash. Scale the
  // radius to the tile so the picture stays readable through the blur.
  const filter = (st.cssFilter || "").replace(
    /blur\(([\d.]+)px\)/,
    (_, n) => `blur(${(Number(n) * 0.15).toFixed(2)}px)`
  );
  // The shake's offset is in design pixels against a 1080 short side; the
  // swatch is a fraction of that, so the offset is scaled up just enough to
  // read as a tremble at tile size.
  const pct = (px: number) => (px / 1080) * 40;
  const shake =
    st.dx || st.dy || st.zoom
      ? `translate(${pct(st.dx ?? 0).toFixed(2)}%, ${pct(st.dy ?? 0).toFixed(2)}%) scale(${st.zoom ?? 1})`
      : undefined;
  // A zoom scales about the point it holds; everything else about the middle.
  const origin = st.origin ? `${st.origin.x * 100}% ${st.origin.y * 100}%` : undefined;
  // The glitch's chroma ghost is a few pixels of screen blend, and bright
  // footage swallows it at tile size. The swatch tears the picture the way
  // the full-size channel shift reads: strips of the frame knocked sideways,
  // jumping on the preview state's quantized clock.
  const tears =
    id === "glitch"
      ? [0, 1].map((i) => {
          const step = Math.floor(t * 9) + 3 * i;
          const j = ((step * 7919) % 5) - 2; // -2..2, deterministic
          return {
            top: i ? 58 : 22,
            h: i ? 8 : 12,
            dx: (j || 1) * (i ? -2.6 : 3.2),
          };
        })
      : [];
  return (
    <span
      data-drag-object
      className={cn("relative block aspect-square overflow-hidden rounded-md bg-black", className)}
    >
      {!!st.ghostFrac && (
        <span
          className="absolute inset-0 opacity-60 mix-blend-screen"
          style={{ transform: `translateX(${(st.ghostFrac * 900).toFixed(2)}%)` }}
        >
          <SwatchScene frame={frame} />
        </span>
      )}
      <span
        className="absolute inset-0"
        style={{ filter: filter || undefined, transform: shake, transformOrigin: origin }}
      >
        <SwatchScene frame={frame} />
      </span>
      {tears.map((tear) => (
        <span
          key={tear.top}
          className="absolute inset-0"
          style={{
            clipPath: `inset(${tear.top}% 0 ${100 - tear.top - tear.h}% 0)`,
            transform: `translateX(${tear.dx.toFixed(2)}%)`,
          }}
        >
          <SwatchScene frame={frame} />
        </span>
      ))}
      {!!st.grain && grainUrl && (
        <span
          className="cut-grain absolute inset-0"
          style={{ opacity: st.grain, backgroundImage: `url(${grainUrl})` }}
        />
      )}
      {!!st.vignette && st.vignette > 0 && (
        <span
          className="absolute inset-0"
          style={{
            background: `radial-gradient(circle at 50% 50%, transparent 30%, rgba(0,0,0,${st.vignette.toFixed(2)}) 100%)`,
          }}
        />
      )}
      {wash && (
        <span
          className="absolute inset-0"
          style={{
            background: wash.color,
            opacity: Math.min(0.7, wash.alpha * 2.5),
            // The recipe names its wash with a canvas composite op; the ones
            // effects use are CSS blend modes by the same name.
            mixBlendMode: wash.mode as React.CSSProperties["mixBlendMode"],
          }}
        />
      )}
      {st.leak && (
        // Each gradient — the bloom, then every streak band — lands twice,
        // the canvas pass's two blends: screen lights the darks, the plain
        // layer tints the brights.
        <span className="absolute inset-0">
          {[
            { bg: leakGradient(st.leak.x, st.leak.y), alpha: st.leak.alpha },
            ...st.leak.streaks.map((s) => ({ bg: streakGradient(s), alpha: s.alpha })),
          ].map((l, j) => (
            <span key={j} className="absolute inset-0">
              <span
                className="absolute inset-0 mix-blend-screen"
                style={{ opacity: l.alpha, background: l.bg }}
              />
              <span
                className="absolute inset-0"
                style={{ opacity: l.alpha * LEAK_TINT, background: l.bg }}
              />
            </span>
          ))}
        </span>
      )}
      {!!st.flash && (
        <span className="absolute inset-0 bg-white" style={{ opacity: Math.min(0.75, st.flash) }} />
      )}
    </span>
  );
}

