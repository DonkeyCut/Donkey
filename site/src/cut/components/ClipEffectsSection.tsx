"use client";

import { X } from "lucide-react";
import { Fragment } from "react";
import {
  AMOUNTLESS_EFFECTS,
  CLIP_EFFECT_IDS,
  EFFECT_LABELS,
  type ClipEffect,
  type ClipEffectId,
} from "@donkeycut/effects-kit";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { FlashPulseRows, type PulseWrite } from "@/cut/components/FlashPulseRows";
import { Row, Section, useSliderCheckpoint } from "@/cut/components/panelBits";
import { parsePercentInput } from "@/cut/components/ScrubValue";
import { ValueSlider } from "@/cut/components/ValueSlider";
import { useEditor } from "@/cut/lib/store";
import type { VideoClip } from "@/cut/lib/types";

/**
 * The effects a clip wears: each treats this clip's picture alone, inside its
 * mask, for the clip's whole length. A masked copy over the shot wearing a
 * negative turns only the window. The same list the chat's set_clip_effects
 * writes.
 */
export function ClipEffectsSection({ clip }: { clip: VideoClip }) {
  const ck = useSliderCheckpoint();
  const list = clip.effects ?? [];
  const st = () => useEditor.getState();
  const write = (effects: ClipEffect[]) => st().updateClip(clip.id, { effects: effects.length ? effects : undefined });

  // An effect is worn once; the picker offers the ones the clip lacks.
  const free = CLIP_EFFECT_IDS.filter((id) => !list.some((e) => e.effect === id));

  // The amount drags as one undo step, the way every inspector slider does.
  const setAmount = (i: number, amount: number) => {
    ck.begin();
    st().updateClipTransient(clip.id, { effects: list.map((e, j) => (j === i ? { ...e, amount } : e)) });
  };

  // A flash's pulse rows write into its entry: drafts ride the transient
  // path under the rows' own checkpoint, clicks land as one step.
  const setPulse = (i: number, patch: Partial<ClipEffect>, how: PulseWrite) => {
    const effects = list.map((e, j) => (j === i ? { ...e, ...patch } : e));
    if (how === "draft") {
      st().updateClipTransient(clip.id, { effects });
      return;
    }
    write(effects);
  };

  return (
    <Section
      title="Effects"
      info="Each effect treats this clip's picture alone, inside its mask, for the clip's whole length. An effect from the Effects tab treats the whole frame under its window."
      aside={
        free.length > 0 && (
          <Select
            value={null}
            items={Object.fromEntries(free.map((id) => [id, EFFECT_LABELS[id]]))}
            onValueChange={(v) => {
              if (v) write([...list, { effect: v as ClipEffectId }]);
            }}
          >
            <SelectTrigger className="h-7 w-28 text-[12px]">
              <SelectValue placeholder="Add effect" />
            </SelectTrigger>
            <SelectContent>
              {free.map((id) => (
                <SelectItem key={id} value={id} className="text-[12px]">
                  {EFFECT_LABELS[id]}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        )
      }
    >
      {list.map((e, i) => (
        <Fragment key={e.effect}>
          <Row label={EFFECT_LABELS[e.effect]}>
            {!AMOUNTLESS_EFFECTS.includes(e.effect) && (
              <ValueSlider
                label={`${EFFECT_LABELS[e.effect]} amount`}
                sliderClassName="data-horizontal:w-24"
                valueClassName="w-9 text-muted-foreground"
                value={e.amount ?? 0.5}
                min={0.05}
                max={1}
                step={0.01}
                snap={[0.5]}
                format={(v) => String(Math.round(v * 100))}
                parse={parsePercentInput}
                onDraft={(v) => setAmount(i, v)}
                onCommit={(v) => {
                  setAmount(i, v);
                  ck.end();
                }}
              />
            )}
            <Tooltip>
              <TooltipTrigger
                aria-label={`Remove ${EFFECT_LABELS[e.effect]}`}
                className="grid size-6 place-items-center rounded text-muted-foreground transition-colors hover:text-foreground"
                onClick={() => write(list.filter((_, j) => j !== i))}
              >
                <X className="size-3.5" />
              </TooltipTrigger>
              <TooltipContent>Remove</TooltipContent>
            </Tooltip>
          </Row>
          {e.effect === "flash" && <FlashPulseRows pulse={e} write={(patch, how) => setPulse(i, patch, how)} />}
        </Fragment>
      ))}
    </Section>
  );
}
