"use client";

import { FLASH_RHYTHMS, FLASH_RATE_MAX, FLASH_TONES, type FlashRhythm, type FlashPulse, type FlashTone } from "@donkeycut/effects-kit";
import { Row, useSliderCheckpoint } from "@/cut/components/panelBits";
import { parseNumberInput } from "@/cut/components/ScrubValue";
import { ValueSlider } from "@/cut/components/ValueSlider";
import { cn } from "@/lib/utils";

const FLASH_TONE_LABELS: Record<FlashTone, string> = { white: "White", black: "Black" };
const FLASH_RHYTHM_LABELS: Record<FlashRhythm, string> = { strobe: "Strobe", flicker: "Flicker" };

/** How a write lands: `draft` while a slider drags (one undo step, closed by
 * the checkpoint), `commit` for a single click. */
export type PulseWrite = "draft" | "commit";

/** A two-way segmented choice in the flash rows. */
function Segmented<T extends string>({ items, value, labels, onPick }: { items: readonly T[]; value: T; labels: Record<T, string>; onPick: (v: T) => void }) {
  return (
    <div className="flex w-36 rounded-lg border border-input p-0.5 text-[11.5px] font-medium">
      {items.map((c) => (
        <button
          key={c}
          type="button"
          aria-pressed={value === c}
          className={cn(
            "flex-1 rounded-md px-1 py-1 whitespace-nowrap transition-colors",
            value === c ? "bg-neutral-900 text-white" : "text-muted-foreground hover:text-foreground"
          )}
          onClick={() => onPick(c)}
        >
          {labels[c]}
        </button>
      ))}
    </div>
  );
}

/** A flash's tone and strobe: one pop, or a pulse held on and off at a rate
 * (0 = the single pop), each pulse at full strength or dealt its own. The
 * effect element and a clip's own flash share these rows; defaults write as
 * absence. */
export function FlashPulseRows({ pulse, write }: { pulse: FlashPulse; write: (patch: FlashPulse, how: PulseWrite) => void }) {
  const rateCk = useSliderCheckpoint();
  return (
    <>
      <Row label="Tone">
        <Segmented
          items={FLASH_TONES}
          value={pulse.tone ?? "white"}
          labels={FLASH_TONE_LABELS}
          onPick={(c) => write({ tone: c === "white" ? undefined : c }, "commit")}
        />
      </Row>
      <Row label="Strobe">
        <ValueSlider
          label="Strobe rate"
          sliderClassName="data-horizontal:w-24"
          valueClassName="w-9 text-muted-foreground"
          value={pulse.rate ?? 0}
          min={0}
          max={FLASH_RATE_MAX}
          step={0.5}
          format={(v) => (v ? `${v}/s` : "Off")}
          parse={(raw) => (raw.trim().toLowerCase() === "off" ? 0 : parseNumberInput(raw.replace(/\/s$/, "")))}
          onDraft={(v) => {
            rateCk.begin();
            write({ rate: v || undefined }, "draft");
          }}
          onCommit={(v) => {
            rateCk.begin();
            write({ rate: v || undefined }, "draft");
            rateCk.end();
          }}
        />
      </Row>
      {!!pulse.rate && (
        <Row label="Rhythm">
          <Segmented
            items={FLASH_RHYTHMS}
            value={pulse.rhythm ?? "strobe"}
            labels={FLASH_RHYTHM_LABELS}
            onPick={(c) => write({ rhythm: c === "strobe" ? undefined : c }, "commit")}
          />
        </Row>
      )}
    </>
  );
}
