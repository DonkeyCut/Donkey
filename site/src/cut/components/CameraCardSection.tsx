"use client";

import { useTranslations } from "next-intl";

import { Switch } from "@/components/ui/switch";
import { Button } from "@/components/ui/button";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import {
  CARD_BLEED_MAX,
  CARD_FEATHER_MAX,
  CARD_OFFSET_MAX,
  CARD_RADIUS_MAX,
  CARD_SCALE_MAX,
  CARD_SCALE_MIN,
  CARD_SIDES,
  CARD_TOP_MAX,
  CARD_TOP_MIN,
  CARD_WIDTH_MAX,
  CARD_WIDTH_MIN,
  cardMatteKey,
  newCard,
  normalizeCard,
  resolveCardShape,
  type CameraCard,
  type CardSide,
} from "@/cut/lib/cameraCard";
import { retryCardMatte, useMatteBakes } from "@/cut/lib/removal/bakeJobs";
import { useEditor } from "@/cut/lib/store";
import { frameOf, rectOf, type VideoClip } from "@/cut/lib/types";
import { ResetButton, Row, Section, useSliderCheckpoint } from "@/cut/components/panelBits";
import { parseNumberInput, parsePercentInput, ScrubValue } from "@/cut/components/ScrubValue";
import { ValueSlider } from "@/cut/components/ValueSlider";
import { useDescribeError } from "@/i18n/describeError";

const formatPercent = (v: number) => `${Math.round(v * 100)}%`;
const formatPx = (v: number) => String(Math.round(v));

/**
 * The camera card: the talking-head split layout on one clip, in any frame
 * shape. The picture shows through a rounded card along the bottom or one
 * side of the clip's box, and with Pop out on the speaker's head shows above
 * the card's edge, keyed by the free person matte this section starts
 * baking. Side, top and width show what the card draws at, defaults
 * included. Every field is what set_camera_card writes; drafts stream
 * through the transient updater under one checkpoint per gesture.
 */
export function CameraCardSection({ clip }: { clip: VideoClip }) {
  const t = useTranslations("editor.cameraCard");
  const describeError = useDescribeError();
  const card = clip.card;
  const st = () => useEditor.getState();
  const ck = useSliderCheckpoint();
  const job = useMatteBakes((s) => s.jobs[cardMatteKey(clip.id)]);
  const aspect = useEditor((s) => s.aspect);
  const asset = useEditor((s) => s.assets.find((a) => a.id === clip.assetId));
  const current = () => st().clips.find((c) => c.id === clip.id)?.card;
  const draft = (patch: Partial<CameraCard>) => {
    const c = current();
    if (!c) return;
    ck.begin();
    st().updateClipTransient(clip.id, { card: normalizeCard({ ...c, ...patch }) });
  };
  const commit = (patch: Partial<CameraCard>) => {
    draft(patch);
    ck.end();
  };

  const slider = (
    label: string,
    key: "top" | "width" | "shadow" | "scale",
    value: number,
    min: number,
    max: number,
    snap?: number[],
    reset?: { show: boolean; onClick: () => void; title: string }
  ) => (
    <Row label={label}>
      {reset && <ResetButton title={reset.title} show={reset.show} onClick={reset.onClick} />}
      <ValueSlider
        label={label}
        sliderClassName="data-horizontal:w-24"
        valueClassName="w-9 text-muted-foreground"
        value={value}
        min={min}
        max={max}
        step={0.01}
        snap={snap}
        format={formatPercent}
        parse={parsePercentInput}
        onDraft={(v) => draft({ [key]: v })}
        onCommit={(v) => commit({ [key]: v })}
      />
    </Row>
  );
  const scrub = (
    label: string,
    key: "radius" | "sideBleed" | "feather" | "offsetX" | "offsetY",
    value: number,
    min: number,
    max: number,
    step: number,
    format: (v: number) => string,
    parse: (raw: string) => number | null
  ) => (
    <ScrubValue
      label={label}
      className="w-9 text-muted-foreground"
      value={value}
      min={min}
      max={max}
      step={step}
      format={format}
      parse={parse}
      onScrub={(v) => draft({ [key]: v })}
      onCommit={(v) => commit({ [key]: v })}
    />
  );

  const fr = frameOf(aspect);
  const rect = rectOf(clip);
  const shape = card
    ? resolveCardShape(card, rect.w * fr.w, rect.h * fr.h, asset?.width ?? 0, asset?.height ?? 0)
    : null;
  // The side names, keyed by side; auto names the side it resolved to.
  const sideLabels: Record<CardSide, string> = {
    bottom: t("side.bottom"),
    left: t("side.left"),
    right: t("side.right"),
  };
  const sideItems = {
    auto: t("side.auto", { side: sideLabels[shape?.side ?? "bottom"] }),
    ...sideLabels,
  };

  const matteLine = !card?.popOut
    ? null
    : card.matte
      ? t("matteReady")
      : job?.status === "running"
        ? t("matteBaking", { progress: job.progress })
        : job?.status === "error"
          ? describeError(job, t("matteFailed"))
          : t("matteStarting");

  return (
    <Section
      title={t("title")}
      info={t("info")}
      enabled={!!card}
      onEnabledChange={(v) => st().updateClip(clip.id, { card: v ? newCard() : undefined })}
    >
      {card && shape && (
        <>
          <Row label={t("sideLabel")}>
            <Select
              value={card.side ?? "auto"}
              items={sideItems}
              onValueChange={(v) =>
                st().updateClip(clip.id, {
                  card: normalizeCard({
                    ...card,
                    side: CARD_SIDES.includes(v as CardSide) ? (v as CardSide) : undefined,
                    top: undefined,
                    width: undefined,
                  }),
                })
              }
            >
              <SelectTrigger className="h-8 w-36 text-[12px]">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {(Object.keys(sideItems) as (keyof typeof sideItems)[]).map((id) => (
                  <SelectItem key={id} value={id} className="text-[12px]">
                    {sideItems[id]}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </Row>
          {slider(t("top"), "top", shape.top, CARD_TOP_MIN, CARD_TOP_MAX, undefined, {
            title: t("resetTop"),
            show: card.top !== undefined,
            onClick: () => st().updateClip(clip.id, { card: { ...card, top: undefined } }),
          })}
          {shape.side !== "bottom" &&
            slider(t("width"), "width", shape.width, CARD_WIDTH_MIN, CARD_WIDTH_MAX, undefined, {
              title: t("resetWidth"),
              show: card.width !== undefined,
              onClick: () => st().updateClip(clip.id, { card: { ...card, width: undefined } }),
            })}
          <Row label={t("radius")}>
            {scrub(t("cardRadius"), "radius", card.radius, 0, CARD_RADIUS_MAX, 1, formatPx, parseNumberInput)}
          </Row>
          <Row label={t("sideBleed")}>
            {scrub(t("cardSideBleed"), "sideBleed", card.sideBleed, 0, CARD_BLEED_MAX, 1, formatPx, parseNumberInput)}
          </Row>
          {slider(t("shadow"), "shadow", card.shadow, 0, 1)}
          <Row label={t("popOut")}>
            <Switch
              aria-label={t("popOut")}
              checked={card.popOut}
              onCheckedChange={(popOut) => st().updateClip(clip.id, { card: { ...card, popOut } })}
            />
          </Row>
          {card.popOut && (
            <Row label={t("feather")}>
              {scrub(t("popOutFeather"), "feather", card.feather, 0, CARD_FEATHER_MAX, 1, formatPx, parseNumberInput)}
            </Row>
          )}
          {matteLine && (
            <div className="flex min-h-7 items-center justify-between gap-2 text-[12px] text-muted-foreground">
              <span className="truncate">{matteLine}</span>
              {job?.status === "error" && (
                <Button size="sm" variant="outline" onClick={() => retryCardMatte(clip.id)}>
                  {t("retry")}
                </Button>
              )}
            </div>
          )}
          {slider(t("footageSize"), "scale", card.scale ?? 1, CARD_SCALE_MIN, CARD_SCALE_MAX, [1])}
          <Row label={t("footageOffset")}>
            {(
              [
                ["X", "offsetX", card.offsetX ?? 0],
                ["Y", "offsetY", card.offsetY ?? 0],
              ] as const
            ).map(([axis, key, value]) => (
              <span key={axis} className="flex items-center gap-1">
                <span className="text-[11px] text-muted-foreground/70 uppercase">{axis}</span>
                {scrub(t("footageAxisOffset", { axis }), key, value, -CARD_OFFSET_MAX, CARD_OFFSET_MAX, 0.01, formatPercent, parsePercentInput)}
              </span>
            ))}
          </Row>
        </>
      )}
    </Section>
  );
}
