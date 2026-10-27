"use client";

import { useTranslations } from "next-intl";
import { EASE_IDS, FLASH_FADE_CHOICES, FLASH_FADE_NONE, FLASH_RHYTHMS, FLASH_RATE_MAX, FLASH_TONES, type FlashFadeChoice, type FlashRhythm, type FlashPulse, type FlashTone } from "@donkeycut/effects-kit";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Row, useSliderCheckpoint } from "@/cut/components/panelBits";
import { parseNumberInput } from "@/cut/components/ScrubValue";
import { ValueSlider } from "@/cut/components/ValueSlider";
import { useLabels } from "@/i18n/labels";
import { cn } from "@/lib/utils";

/** How a write lands: `draft` while a slider drags (one undo step, closed by
 * the checkpoint), `commit` for a single click. */
export type PulseWrite = "draft" | "commit";

/** A segmented choice in the flash rows. */
function Segmented<T extends string>({ items, value, labels, onPick }: { items: readonly T[]; value: T; labels: Record<T, string>; onPick: (v: T) => void }) {
  return (
    <div className="flex w-36 rounded-lg border border-input p-0.5 text-[11.5px] font-medium">
      {items.map((c) => (
        <button
          key={c}
          type="button"
          aria-pressed={value === c}
          className={cn(
            "min-w-0 flex-1 truncate rounded-md px-1 py-1 whitespace-nowrap transition-colors",
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
  const t = useTranslations("timeline.flash");
  const rateCk = useSliderCheckpoint();

  // The segment names in the page's language, keyed by the choices' ids.
  const toneLabels: Record<FlashTone, string> = { white: t("tones.white"), black: t("tones.black") };
  const rhythmLabels: Record<FlashRhythm, string> = { strobe: t("rhythms.strobe"), flicker: t("rhythms.flicker") };
  const off = t("off");
  return (
    <>
      <Row label={t("tone")}>
        <Segmented
          items={FLASH_TONES}
          value={pulse.tone ?? "white"}
          labels={toneLabels}
          onPick={(c) => write({ tone: c === "white" ? undefined : c }, "commit")}
        />
      </Row>
      <Row label={t("strobe")}>
        <ValueSlider
          label={t("strobeRate")}
          sliderClassName="data-horizontal:w-24"
          valueClassName="w-9 text-muted-foreground"
          value={pulse.rate ?? 0}
          min={0}
          max={FLASH_RATE_MAX}
          step={0.5}
          format={(v) => (v ? `${v}/s` : off)}
          parse={(raw) => (raw.trim().toLowerCase() === off.toLowerCase() ? 0 : parseNumberInput(raw.replace(/\/s$/, "")))}
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
        <Row label={t("rhythm")}>
          <Segmented
            items={FLASH_RHYTHMS}
            value={pulse.rhythm ?? "strobe"}
            labels={rhythmLabels}
            onPick={(c) => write({ rhythm: c === "strobe" ? undefined : c }, "commit")}
          />
        </Row>
      )}
    </>
  );
}

/** A flash element's fade: off (the pop), into the tone, or out of it, and
 * the curve it runs along. Off and the even ramp write as absence. */
export function FlashFadeRow({ pulse, write }: { pulse: FlashPulse; write: (patch: FlashPulse, how: PulseWrite) => void }) {
  const t = useTranslations("timeline.flash");
  const easeLabel = useLabels("ease");

  // The fade's segments and the curve menu's names, in the page's language.
  const fadeLabels: Record<FlashFadeChoice, string> = { none: t("fades.none"), to: t("fades.to"), from: t("fades.from") };
  const easeItems: Record<string, string> = Object.fromEntries(EASE_IDS.map((id) => [id, easeLabel(id)]));
  return (
    <>
      <Row label={t("fade")}>
        <Segmented
          items={FLASH_FADE_CHOICES}
          value={pulse.fade ?? FLASH_FADE_NONE}
          labels={fadeLabels}
          onPick={(c) => write({ fade: c === FLASH_FADE_NONE ? undefined : c }, "commit")}
        />
      </Row>
      {pulse.fade && (
        <Row label={t("curve")}>
          <Select
            value={pulse.fadeEase ?? "linear"}
            items={easeItems}
            onValueChange={(id) => write({ fadeEase: id === "linear" ? undefined : (id as FlashPulse["fadeEase"]) }, "commit")}
          >
            <SelectTrigger className="h-8 w-36 text-[12px]">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {EASE_IDS.map((id) => (
                <SelectItem key={id} value={id} className="text-[12px]">
                  {easeLabel(id)}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </Row>
      )}
    </>
  );
}
