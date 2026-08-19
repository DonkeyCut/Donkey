"use client";

import { useRef } from "react";
import { Slider } from "@/components/ui/slider";
import { ScrubValue } from "@/cut/components/ScrubValue";

/**
 * The one way a settings row exposes a numeric value: a slider and, beside
 * it, the same value as an editable readout — drag either to scrub, click the
 * readout to type an exact number. Rendering both from one set of bounds and
 * formatters keeps every panel row manually editable and keeps the row from
 * shifting while the readout is edited (the readout pins its width for the
 * edit). A test bans raw `<Slider` in the editor's components, so a new
 * settings row inherits all of this by construction.
 *
 * `onDraft` streams transient values from either control — pair it with a
 * draft state so preview follows the gesture; `onCommit` fires once per
 * gesture (slider release, readout commit) and is the place to write history
 * and clear the draft.
 */
export function ValueSlider({
  label,
  value,
  min,
  max,
  step,
  snap,
  keyStep,
  scrubMin,
  scrubMax,
  format,
  parse,
  onDraft,
  onCommit,
  disabled,
  sliderClassName,
  valueClassName,
}: {
  label: string;
  value: number;
  min: number;
  max: number;
  step: number;
  /** Detent values, applied to slider drags and readout scrubs alike. */
  snap?: number[];
  keyStep?: number;
  /** Typed/scrubbed bounds when the readout accepts more than the slider
   * shows (a speed field caps its slider yet takes any typed rate). */
  scrubMin?: number;
  scrubMax?: number;
  format: (v: number) => string;
  parse: (raw: string) => number | null;
  onDraft?: (v: number) => void;
  onCommit: (v: number) => void;
  disabled?: boolean;
  sliderClassName?: string;
  valueClassName?: string;
}) {
  // The slider commits what was last drafted: the draft passed through the
  // snap wrapper, so committing it (over Base UI's own committed argument)
  // keeps a detented drag exactly on its detent.
  const lastDraft = useRef<number | null>(null);
  return (
    <>
      <Slider
        className={sliderClassName}
        min={min}
        max={max}
        step={step}
        snap={snap}
        value={Math.min(max, Math.max(min, value))}
        disabled={disabled}
        aria-label={label}
        onValueChange={(v) => {
          lastDraft.current = Number(v);
          onDraft?.(Number(v));
        }}
        onValueCommitted={() => {
          if (lastDraft.current != null) onCommit(lastDraft.current);
          lastDraft.current = null;
        }}
      />
      <ScrubValue
        label={label}
        className={valueClassName}
        value={value}
        min={scrubMin ?? min}
        max={scrubMax ?? max}
        step={step}
        keyStep={keyStep}
        snap={snap}
        format={format}
        parse={parse}
        disabled={disabled}
        onScrub={onDraft}
        onCommit={onCommit}
      />
    </>
  );
}
