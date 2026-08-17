"use client";

import { useRef, useState } from "react";
import { Check, Pipette } from "lucide-react";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { parsePercentInput, ScrubValue } from "@/cut/components/ScrubValue";
import { cn } from "@/lib/utils";

/** The named colors every color field offers. */
export const COLOR_PRESETS: { hex: string; name: string }[] = [
  { hex: "#FFFFFF", name: "White" },
  { hex: "#111114", name: "Black" },
  { hex: "#8E8E93", name: "Grey" },
  { hex: "#FF375F", name: "Red" },
  { hex: "#FF9F0A", name: "Orange" },
  { hex: "#FFD60A", name: "Yellow" },
  { hex: "#30D158", name: "Green" },
  { hex: "#0A84FF", name: "Blue" },
  { hex: "#BF5AF2", name: "Purple" },
];

/** Colors the user picked by hand, newest first. */
const RECENT_COLORS_KEY = "cut-recent-colors";
const RECENT_LIMIT = 8;

export function readRecentColors(): string[] {
  if (typeof window === "undefined") return [];
  try {
    const v = JSON.parse(localStorage.getItem(RECENT_COLORS_KEY) ?? "[]") as unknown;
    return Array.isArray(v)
      ? v.filter((x): x is string => typeof x === "string").slice(0, RECENT_LIMIT)
      : [];
  } catch {
    return [];
  }
}

function writeRecentColors(list: string[]) {
  try {
    localStorage.setItem(RECENT_COLORS_KEY, JSON.stringify(list));
  } catch {
    // Storage full or blocked — recents just won't persist.
  }
}

/** "#abc", "abc", "AABBCC" → "#AABBCC". Anything else is null. */
export function parseHex(raw: string): string | null {
  const m = /^#?([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(raw.trim());
  if (!m) return null;
  const h = m[1];
  return `#${(h.length === 3 ? [...h].map((c) => c + c).join("") : h).toUpperCase()}`;
}

const safeHex = (raw: string) => parseHex(raw) ?? "#FFFFFF";

type Hsv = { h: number; s: number; v: number };

function hexToHsv(hex: string): Hsv {
  const n = parseInt(hex.slice(1), 16);
  const r = ((n >> 16) & 255) / 255;
  const g = ((n >> 8) & 255) / 255;
  const b = (n & 255) / 255;
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const d = max - min;
  let h = 0;
  if (d) {
    if (max === r) h = ((g - b) / d) % 6;
    else if (max === g) h = (b - r) / d + 2;
    else h = (r - g) / d + 4;
    h = (h * 60 + 360) % 360;
  }
  return { h, s: max ? d / max : 0, v: max };
}

function hsvToHex({ h, s, v }: Hsv): string {
  const hue = ((h % 360) + 360) % 360;
  const c = v * s;
  const x = c * (1 - Math.abs(((hue / 60) % 2) - 1));
  const m = v - c;
  const [r, g, b] = [
    [c, x, 0],
    [x, c, 0],
    [0, c, x],
    [0, x, c],
    [x, 0, c],
    [c, 0, x],
  ][Math.floor(hue / 60) % 6];
  const ch = (t: number) =>
    Math.round((t + m) * 255)
      .toString(16)
      .padStart(2, "0");
  return `#${ch(r)}${ch(g)}${ch(b)}`.toUpperCase();
}

const clamp01 = (n: number) => Math.min(1, Math.max(0, n));

/**
 * The compact color control: a swatch that opens the picker, the hex readout
 * that opens the presets and recents list, and an optional opacity readout —
 * one row where a strip of swatches used to sit. `onBegin` marks an undo
 * checkpoint, `onLive` streams a drag, `onCommit` sets a final pick.
 */
export function ColorField({
  value,
  onBegin,
  onLive,
  onCommit,
  opacity,
  label = "Color",
  className,
}: {
  value: string;
  onBegin: () => void;
  onLive: (hex: string) => void;
  onCommit: (hex: string) => void;
  /** Folds the paired opacity into the same row. Omit for opaque colors. */
  opacity?: {
    value: number;
    label: string;
    onDraft: (v: number) => void;
    onCommit: (v: number) => void;
  };
  label?: string;
  className?: string;
}) {
  const [pickerOpen, setPickerOpen] = useState(false);
  const [listOpen, setListOpen] = useState(false);
  const hex = safeHex(value);

  const commit = (next: string) => {
    if (!COLOR_PRESETS.some((p) => p.hex === next)) {
      writeRecentColors([next, ...readRecentColors().filter((r) => r !== next)].slice(0, RECENT_LIMIT));
    }
    onCommit(next);
  };

  return (
    <div
      className={cn(
        "color-field flex h-7 shrink-0 items-center gap-1.5 rounded-md bg-secondary/60 pr-1.5 pl-1",
        className
      )}
    >
      <Popover open={pickerOpen} onOpenChange={setPickerOpen}>
        <PopoverTrigger
          aria-label={`${label} — open the picker`}
          title="Pick a color"
          className="color-field-swatch size-5 shrink-0 rounded-[5px] shadow-xs ring-1 ring-border transition-transform outline-none hover:scale-105 focus-visible:ring-2 focus-visible:ring-primary/60"
          style={{ background: hex }}
        />
        <PopoverContent side="bottom" align="end" sideOffset={6} className="w-56 p-2.5">
          <ColorPicker value={hex} onBegin={onBegin} onLive={onLive} onCommit={commit} />
        </PopoverContent>
      </Popover>
      <Popover open={listOpen} onOpenChange={setListOpen}>
        <PopoverTrigger
          aria-label={`${label} — open the list`}
          className="color-field-value w-[7ch] shrink-0 rounded-sm text-left font-mono text-[11.5px] tabular-nums text-foreground uppercase outline-none focus-visible:ring-2 focus-visible:ring-primary/60"
        >
          {hex.slice(1)}
        </PopoverTrigger>
        <PopoverContent side="bottom" align="end" sideOffset={6} className="w-56 p-1">
          <ColorList
            value={hex}
            onPick={(c) => {
              commit(c);
              setListOpen(false);
            }}
          />
        </PopoverContent>
      </Popover>
      {opacity && (
        <ScrubValue
          label={opacity.label}
          className="w-[4.5ch] text-muted-foreground"
          value={opacity.value}
          min={0}
          max={1}
          step={0.01}
          format={(v) => `${Math.round(v * 100)}%`}
          parse={parsePercentInput}
          onScrub={opacity.onDraft}
          onCommit={opacity.onCommit}
        />
      )}
    </div>
  );
}

/** Saturation/value pad, hue rail, hex entry, and the eyedropper. */
function ColorPicker({
  value,
  onBegin,
  onLive,
  onCommit,
}: {
  value: string;
  onBegin: () => void;
  onLive: (hex: string) => void;
  onCommit: (hex: string) => void;
}) {
  // The pad keeps its own hue and saturation: at pure black or white hex can
  // no longer carry them, so a drag through the corner would lose the color.
  // A value the pad did not author (a list pick, an undo) resets it.
  const [pad, setPad] = useState(() => ({ hex: value, hsv: hexToHsv(value) }));
  if (pad.hex !== value) setPad({ hex: value, hsv: hexToHsv(value) });
  const hsv = pad.hsv;

  const push = (next: Hsv) => {
    const hex = hsvToHex(next);
    setPad({ hex, hsv: next });
    onLive(hex);
  };

  const hueCss = `hsl(${Math.round(hsv.h)} 100% 50%)`;

  return (
    <div className="flex flex-col gap-2.5">
      <DragArea
        label="Saturation and brightness"
        className="relative h-28 w-full cursor-crosshair rounded-md ring-1 ring-border"
        style={{
          background: `linear-gradient(to top, #000, transparent), linear-gradient(to right, #fff, ${hueCss})`,
        }}
        onStart={onBegin}
        onDrag={(x, y) => push({ ...hsv, s: x, v: 1 - y })}
        onEnd={() => onCommit(hsvToHex(hsv))}
      >
        <Handle color={value} left={hsv.s} top={1 - hsv.v} />
      </DragArea>
      <DragArea
        label="Hue"
        className="relative h-3 w-full cursor-ew-resize rounded-full ring-1 ring-border"
        style={{
          background:
            "linear-gradient(to right, #FF0000, #FFFF00, #00FF00, #00FFFF, #0000FF, #FF00FF, #FF0000)",
        }}
        onStart={onBegin}
        onDrag={(x) => push({ ...hsv, h: x * 360 })}
        onEnd={() => onCommit(hsvToHex(hsv))}
      >
        <Handle color={hueCss} left={hsv.h / 360} top={0.5} />
      </DragArea>
      <div className="flex items-center gap-1.5">
        <HexInput value={value} onCommit={onCommit} className="h-7 flex-1" />
        <Eyedropper
          onPick={(hex) => {
            onBegin();
            onCommit(hex);
          }}
        />
      </div>
    </div>
  );
}

function Handle({ color, left, top }: { color: string; left: number; top: number }) {
  return (
    <span
      className="pointer-events-none absolute size-3.5 -translate-x-1/2 -translate-y-1/2 rounded-full border-2 border-white shadow-[0_0_0_1px_rgba(0,0,0,0.35)]"
      style={{ left: `${left * 100}%`, top: `${top * 100}%`, background: color }}
    />
  );
}

/** Pointer-captured 2D track: reports the grab as fractions of its own box. */
function DragArea({
  label,
  className,
  style,
  onStart,
  onDrag,
  onEnd,
  children,
}: {
  label: string;
  className?: string;
  style?: React.CSSProperties;
  onStart: () => void;
  onDrag: (x: number, y: number) => void;
  onEnd: () => void;
  children: React.ReactNode;
}) {
  const active = useRef(false);
  const emit = (el: HTMLElement, clientX: number, clientY: number) => {
    const r = el.getBoundingClientRect();
    onDrag(clamp01((clientX - r.left) / r.width), clamp01((clientY - r.top) / r.height));
  };
  return (
    <div
      aria-label={label}
      className={cn("touch-none select-none", className)}
      style={style}
      onPointerDown={(e) => {
        if (e.button !== 0) return;
        active.current = true;
        e.currentTarget.setPointerCapture(e.pointerId);
        onStart();
        emit(e.currentTarget, e.clientX, e.clientY);
      }}
      onPointerMove={(e) => {
        if (active.current) emit(e.currentTarget, e.clientX, e.clientY);
      }}
      onPointerUp={(e) => {
        if (!active.current) return;
        active.current = false;
        e.currentTarget.releasePointerCapture(e.pointerId);
        onEnd();
      }}
      onPointerCancel={() => {
        if (!active.current) return;
        active.current = false;
        onEnd();
      }}
    >
      {children}
    </div>
  );
}

/** The presets and the user's recent picks, current value checked. */
function ColorList({ value, onPick }: { value: string; onPick: (hex: string) => void }) {
  const [recents] = useState(readRecentColors);
  const items = [
    ...COLOR_PRESETS,
    ...recents.filter((r) => !COLOR_PRESETS.some((p) => p.hex === r)).map((hex) => ({ hex, name: hex.slice(1) })),
  ];

  return (
    <div className="flex flex-col gap-1">
      <HexInput value={value} onCommit={onPick} autoFocus className="h-8" />
      <div className="max-h-64 overflow-y-auto">
        {items.map((c) => (
          <button
            key={c.hex}
            type="button"
            className="flex h-8 w-full items-center gap-2.5 rounded-md px-2 text-[12.5px] transition-colors hover:bg-secondary"
            onClick={() => onPick(c.hex)}
          >
            <span
              className="size-4 shrink-0 rounded-[4px] ring-1 ring-border"
              style={{ background: c.hex }}
            />
            <span className="min-w-0 truncate">{c.name}</span>
            {value === c.hex && <Check className="ml-auto size-3.5 shrink-0 text-muted-foreground" />}
          </button>
        ))}
      </div>
    </div>
  );
}

/** Hex entry that only reports what parses; garbage snaps back on blur. */
function HexInput({
  value,
  onCommit,
  autoFocus,
  className,
}: {
  value: string;
  onCommit: (hex: string) => void;
  autoFocus?: boolean;
  className?: string;
}) {
  const [entry, setEntry] = useState({ hex: value, draft: value.slice(1) });
  if (entry.hex !== value) setEntry({ hex: value, draft: value.slice(1) });
  const setDraft = (draft: string) => setEntry({ hex: value, draft });

  const commit = () => {
    const hex = parseHex(entry.draft);
    if (hex && hex !== value) onCommit(hex);
    else setDraft(value.slice(1));
  };

  return (
    <div
      className={cn(
        "flex items-center gap-2 rounded-md bg-secondary/60 px-2 focus-within:ring-1 focus-within:ring-primary/60",
        className
      )}
    >
      <span
        className="size-4 shrink-0 rounded-[4px] ring-1 ring-border"
        style={{ background: value }}
      />
      <input
        aria-label="Hex color"
        autoFocus={autoFocus}
        value={entry.draft}
        spellCheck={false}
        className="w-full min-w-0 bg-transparent font-mono text-[11.5px] tabular-nums uppercase outline-none"
        onChange={(e) => setDraft(e.target.value)}
        onFocus={(e) => e.currentTarget.select()}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === "Enter") {
            e.preventDefault();
            commit();
          } else if (e.key === "Escape") {
            setDraft(value.slice(1));
          }
        }}
      />
    </div>
  );
}

type EyeDropperCtor = new () => { open(): Promise<{ sRGBHex: string }> };

/** Screen sampling, on the browsers that carry the EyeDropper API. */
function Eyedropper({ onPick }: { onPick: (hex: string) => void }) {
  const [supported] = useState(() => typeof window !== "undefined" && "EyeDropper" in window);
  if (!supported) return null;
  return (
    <button
      type="button"
      aria-label="Sample a color from the screen"
      title="Sample a color from the screen"
      className="grid size-7 shrink-0 place-items-center rounded-md bg-secondary/60 text-muted-foreground transition-colors hover:text-foreground"
      onClick={async () => {
        const Ctor = (window as unknown as { EyeDropper: EyeDropperCtor }).EyeDropper;
        try {
          const { sRGBHex } = await new Ctor().open();
          const hex = parseHex(sRGBHex);
          if (hex) onPick(hex);
        } catch {
          // Dismissed.
        }
      }}
    >
      <Pipette className="size-3.5" />
    </button>
  );
}
