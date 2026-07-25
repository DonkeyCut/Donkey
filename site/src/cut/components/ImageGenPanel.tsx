"use client";

import { useEffect, useMemo, useRef } from "react";
import { Copy, Loader2, Maximize2, Sparkles, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { DropdownMenuItem } from "@/components/ui/dropdown-menu";
import { SectionTitle } from "@/cut/components/SectionTitle";
import { clearAssetDrag, setAssetDragData } from "@/cut/lib/assetDrag";
import { collectRefs, mentionToken, useRefCandidates, useAssetDrop } from "@/cut/lib/assetRef";
import { genPulseOverlay, useGenPulse } from "@/cut/lib/genNotify";
import { useElapsed } from "@/cut/hooks/useElapsed";
import { signInUrl, useGenerate, useSignedIn, type GenerateJob } from "@/cut/lib/generate";
import {
  IMAGE_RESOLUTION_LABEL,
  useImageGen,
  type ImageAspect,
  type ImageResolution,
} from "@/cut/lib/imageGen";
import { useLightbox } from "@/cut/lib/lightbox";
import { refsFromDroppedFiles } from "@/cut/lib/refMedia";
import { useEditor } from "@/cut/lib/store";
import { nearestAspect, type MediaAsset } from "@/cut/lib/types";
import { cn } from "@/lib/utils";
import { MentionTextarea, RefChips, RefHandlePill } from "./AssetRefs";
import { DictationControl } from "./MicDictation";
import { cardIconButton } from "./iconButton";
import { PillSelect } from "./PillSelect";
import { GeneratedAssetMenu } from "./GeneratedAssetMenu";
import { HostedErrorText } from "./hostedError";

// The generate-image panel: an always-on column in the Image tab, sitting left
// of the stock browser. Clicking a stock tile loads its saved prompt here; the
// user picks a size, edits the prompt, generates on their Donkey account, and
// the results stack below as big tiles.
//
// References ride along as input images: drag any image or video in (stock
// tile, media card, library clip, timeline clip) or mention it by @name.

const ASPECT_WORD: Record<ImageAspect, string> = {
  "16:9": "Landscape",
  "9:16": "Portrait",
  "1:1": "Square",
};

// The resolution tier fixes the long edge (4K caps at the model's 4096×4096 max);
// the short edge follows the aspect ratio. So the exact output pixels depend on both
// controls, which is why the resolution pill shows dimensions for the chosen aspect.
const RES_LONG_EDGE: Record<ImageResolution, number> = { "1K": 1024, "2K": 2048, "4K": 4096 };

function pixelDims(aspect: ImageAspect, resolution: ImageResolution): string {
  const edge = RES_LONG_EDGE[resolution];
  if (aspect === "1:1") return `${edge} × ${edge}`;
  const [w, h] = aspect === "16:9" ? [16, 9] : [9, 16];
  const short = Math.round((edge * Math.min(w, h)) / Math.max(w, h) / 2) * 2;
  return w >= h ? `${edge} × ${short}` : `${short} × ${edge}`;
}

export function ImageGenPanel({ projectId }: { projectId: string }) {
  const { prompt, aspect, resolution, refs } = useImageGen();
  const readOnly = useEditor((s) => s.readOnly);
  const signedIn = useSignedIn();
  const candidates = useRefCandidates();
  const allJobs = useGenerate((s) => s.jobs);
  // Panel renders only — a chat- or scene-owned job lives on its chat card.
  const jobs = allJobs.filter((j) => j.kind === "image" && j.projectId === projectId && !j.chatId);
  // Select the stable `assets` reference and derive here: filtering inside the
  // selector returns a fresh array every store write (including usePlayback's
  // per-frame ticks) and would re-render the panel constantly. Newest first.
  const assets = useEditor((s) => s.assets);
  const generated = useMemo(
    () => assets.filter((a) => a.origin === "generated" && a.type === "image").reverse(),
    [assets]
  );
  const { active: dropActive, attachTarget, targetProps } = useAssetDrop(
    (ref) => {
      if (ref.kind !== "audio") useImageGen.getState().addRef(ref);
    },
    // OS files dropped on the panel attach as references (media files import
    // into the project on the way; text files ride as-is).
    (files) =>
      void refsFromDroppedFiles(projectId, files).then((refs) => {
        for (const r of refs) if (r.kind !== "audio") useImageGen.getState().addRef(r);
      })
  );

  // Default the size to the project's own orientation when the panel opens, so
  // a widescreen project generates landscape images by default (the user can
  // still pick another size). 1:1 has no project counterpart.
  useEffect(() => {
    useImageGen
      .getState()
      .setAspect(
        nearestAspect(useEditor.getState().aspect, Object.keys(ASPECT_WORD) as ImageAspect[])
      );
  }, []);

  const go = () => {
    const { text, refs: all } = collectRefs(prompt.trim(), refs, candidates, { dropAudio: true });
    if (!text) return;
    void useGenerate.getState().generateImage(projectId, text, { refs: all, aspect, resolution });
  };

  return (
    <div ref={attachTarget} {...targetProps} className="relative flex min-h-0 flex-1 flex-col">
      <div className="flex h-12 shrink-0 items-center pr-2.5 pl-4">
        <span className="text-sm font-semibold tracking-tight">Generate image</span>
      </div>

      <div className="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto px-3.5 pb-4">
        {!readOnly && (<>
        {/* Composer: attached references ride as little image thumbnails inside
            the input box, above the prompt (Claude-style). */}
        <div
          className={cn(
            "relative flex shrink-0 flex-col rounded-lg border border-input focus-within:border-ring",
            dropActive && "border-[#0a84ff] ring-2 ring-[#0a84ff]/30 ring-inset"
          )}
        >
          <RefChips
            refs={refs}
            onRemove={(r) => useImageGen.getState().removeRef(r)}
            className="p-2 pb-0"
            peekSide="bottom"
          />
          <MentionTextarea
            className="min-h-[100px] w-full resize-y bg-transparent px-2.5 py-2 pr-9 text-[12.5px] leading-relaxed outline-none"
            placeholder="A neon-lit street market at night, cinematic… Drop an image in or type @ to reference one."
            value={prompt}
            onChange={(v) => useImageGen.getState().setPrompt(v)}
            candidates={candidates}
            submitKey="mod-enter"
            menuSide="bottom"
            onSubmit={go}
          />
          <DictationControl
            text={prompt}
            onResult={(v) => useImageGen.getState().setPrompt(v)}
            buttonClassName="absolute right-2 bottom-2 bg-background/70 backdrop-blur-sm"
          />
        </div>

        {/* Aspect ratio and resolution pills on one row. Closed pills stay short
            ("Landscape", "2K"); the dropdowns carry the technical detail (ratio,
            pixel dimensions). The resolution's pixels follow the chosen aspect. */}
        <div className="flex shrink-0 items-center gap-2">
          <PillSelect
            className="min-w-0 flex-1"
            title="Aspect ratio"
            value={aspect}
            display={ASPECT_WORD[aspect]}
            options={(Object.keys(ASPECT_WORD) as ImageAspect[]).map((a) => ({
              value: a,
              label: `${ASPECT_WORD[a]} · ${a}`,
            }))}
            onChange={(v) => useImageGen.getState().setAspect(v)}
          />
          <PillSelect
            title="Resolution"
            value={resolution}
            display={resolution}
            options={(Object.keys(IMAGE_RESOLUTION_LABEL) as ImageResolution[]).map((r) => ({
              value: r,
              label: `${r} · ${pixelDims(aspect, r)}`,
            }))}
            onChange={(v) => useImageGen.getState().setResolution(v)}
          />
        </div>

        <Button
          className="w-full shrink-0"
          disabled={!prompt.trim() || signedIn === false}
          onClick={go}
        >
          <Sparkles data-icon="inline-start" />
          Generate image
        </Button>

        {signedIn === false && (
          <p className="shrink-0 text-[11px] leading-relaxed text-muted-foreground">
            Generating runs on your Donkey account.{" "}
            <a className="font-medium text-blue-600 hover:underline dark:text-blue-400" href={signInUrl()}>
              Sign in
            </a>{" "}
            to continue.
          </p>
        )}
        </>)}

        {/* Generations in flight (or failed): a finished asset drops into the
            list below, so only the transient states row here. Several can run
            at once — the button stays live while they render. */}
        {jobs
          .filter((j) => j.status !== "done")
          .map((j) => (
            <ImageJobRow key={j.id} job={j} />
          ))}

        {generated.length > 0 && (
          <div className="flex shrink-0 flex-col gap-1.5">
            <SectionTitle>Generated</SectionTitle>
            {generated.map((a) => (
              <GeneratedTile
                key={a.id}
                asset={a}
                projectId={projectId}
                handle={candidates.find((c) => c.scope === "project" && c.id === a.id)?.handle}
              />
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

/** A generated image, shown big: reference it in a prompt by its @handle, drag
 * it onto the timeline or into chat, click to reload its prompt, expand from
 * the corner button, and reach everything else — copy its @reference, send it
 * to Media or the library, delete — through the corner "…" menu. Its name
 * surfaces on hover so the grid stays clean. */
function GeneratedTile({
  asset,
  projectId,
  handle,
}: {
  asset: MediaAsset;
  projectId: string;
  handle?: string;
}) {
  const tileRef = useRef<HTMLDivElement>(null);
  const pulse = useGenPulse("image", asset.id);
  return (
    <div ref={tileRef} className="group relative overflow-hidden rounded-lg">
      <button
        className="block w-full outline-none focus-visible:ring-2 focus-visible:ring-ring"
        title={asset.name}
        draggable
        onDragStart={(e) => {
          setAssetDragData(e, asset.id);
          // Drag the rounded tile itself so the ghost keeps the image's corner
          // radius instead of the browser's square, white-framed default.
          if (tileRef.current) {
            const r = tileRef.current.getBoundingClientRect();
            e.dataTransfer.setDragImage(
              tileRef.current,
              e.clientX - r.left,
              e.clientY - r.top
            );
          }
        }}
        onDragEnd={clearAssetDrag}
        onClick={() => useImageGen.getState().openWith(asset.name)}
      >
        {/* eslint-disable-next-line @next/next/no-img-element -- engine media file, not Next-optimizable */}
        <img
          src={asset.url}
          alt={asset.name}
          loading="lazy"
          className="aspect-[16/10] w-full bg-black object-cover transition-transform group-hover:scale-[1.04]"
        />
      </button>
      {handle && (
        <RefHandlePill
          token={`@${handle}`}
          className="absolute top-1 left-1 opacity-0 transition-opacity group-hover:opacity-100"
        />
      )}
      <div className="pointer-events-none absolute inset-x-0 bottom-0 bg-gradient-to-t from-black/70 to-transparent px-2 py-1.5 opacity-0 transition-opacity group-hover:opacity-100">
        <span className="block truncate text-[11px] font-medium text-white">{asset.name}</span>
      </div>
      <div className="absolute top-1 right-1 flex gap-1">
        <button
          title="Expand"
          className="grid size-5 place-items-center rounded-full bg-black/45 text-white opacity-0 transition-opacity group-hover:opacity-100 hover:bg-black/65"
          onClick={() =>
            useLightbox.getState().open({
              kind: "image",
              src: asset.url,
              name: asset.name,
              prompt: asset.name,
              assetId: asset.id,
            })
          }
        >
          <Maximize2 className="size-3" />
        </button>
        <GeneratedAssetMenu
          asset={asset}
          projectId={projectId}
          triggerClassName="grid size-5 place-items-center rounded-full bg-black/45 text-white opacity-0 transition-opacity group-hover:opacity-100 data-popup-open:opacity-100 hover:bg-black/65"
          before={
            <DropdownMenuItem
              onClick={() =>
                void navigator.clipboard
                  .writeText(handle ? `@${handle}` : mentionToken(asset.name))
                  .catch(() => {})
              }
            >
              <Copy /> Copy reference
            </DropdownMenuItem>
          }
          after={
            <DropdownMenuItem
              variant="destructive"
              onClick={() => useEditor.getState().removeAsset(asset.id)}
            >
              <Trash2 /> Delete
            </DropdownMenuItem>
          }
        />
      </div>
      {pulse && <div aria-hidden className={genPulseOverlay} />}
    </div>
  );
}

/** A generation in flight (or failed) as a compact status row with a live
 * elapsed clock while it renders. */
function ImageJobRow({ job }: { job: GenerateJob }) {
  const elapsed = useElapsed(job.status === "running" ? job.startedAt : null);
  return (
    <div className="group flex shrink-0 items-center gap-2">
      {job.status === "running" && (
        <Loader2 className="size-3.5 shrink-0 animate-spin text-muted-foreground" />
      )}
      <div className="min-w-0 flex-1">
        <div className="truncate text-[11.5px] font-medium">{job.prompt}</div>
        <div
          className={cn(
            "text-[10.5px] leading-snug break-words",
            job.status === "error" ? "text-red-600" : "text-muted-foreground"
          )}
        >
          {job.status === "running" ? (
            <>
              Generating…{" "}
              {elapsed && <span className="tabular-nums text-muted-foreground/80">{elapsed}</span>}
            </>
          ) : (
            <HostedErrorText error={job.error} />
          )}
        </div>
      </div>
      {job.status === "error" && (
        <button
          title="Dismiss"
          className={cn(cardIconButton, "opacity-0 group-hover:opacity-100")}
          onClick={() => useGenerate.getState().dismiss(job.id)}
        >
          <Trash2 className="size-3.5" />
        </button>
      )}
    </div>
  );
}
