"use client";

import { useEffect, useRef } from "react";
import { Copy, Film, Loader2, Maximize2, Plus, RotateCw, Sparkles, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { DropdownMenuItem } from "@/components/ui/dropdown-menu";
import { MEDIA_CORS } from "@/cut/lib/mediaCors";
import { clearAssetDrag, setAssetDragData } from "@/cut/lib/assetDrag";
import { PICKED_RING, useAssetPick } from "@/cut/lib/assetPick";
import {
  collectRefs,
  mentionToken,
  refFromStockVideo,
  useRefCandidates,
  useAssetDrop,
} from "@/cut/lib/assetRef";
import { useElapsed } from "@/cut/hooks/useElapsed";
import { useInView } from "@/cut/hooks/useInView";
import { genPulseOverlay, useGenPulse } from "@/cut/lib/genNotify";
import { signInUrl, useGenerate, useSignedIn, type GenerateJob } from "@/cut/lib/generate";
import { useLightbox } from "@/cut/lib/lightbox";
import { refsFromDroppedFiles } from "@/cut/lib/refMedia";
import { characterPrompt, stockTitle } from "@/cut/lib/stock";
import { useEditor } from "@/cut/lib/store";
import { nearestAspect } from "@/cut/lib/types";
import { useLocalPref } from "@/cut/lib/uiState";
import { useVideoGen } from "@/cut/lib/videoGen";
import {
  VIDEO_ASPECT_LABEL,
  VIDEO_MODELS,
  type VideoAspect,
  type VideoModelOption,
} from "@/cut/lib/videoModels";
import { cn } from "@/lib/utils";
import { CopyHandlePill, MentionTextarea, RefChips } from "./AssetRefs";
import { DictationControl } from "./MicDictation";
import { GeneratedAssetMenu } from "./GeneratedAssetMenu";
import { HostedErrorText } from "./hostedError";
import { cardIconButton } from "./iconButton";
import { PillSelect } from "./PillSelect";
import { ScrollArea } from "@/components/ui/scroll-area";

// The generate-video panel: an always-on column in the Video tab, sitting left
// of the stock-clip browser. Clicking a stock tile loads its saved prompt here.
//
// A visual reference (dragged in or @name-mentioned) seeds the render: the model
// takes one input image, so the first reference's picture becomes the start
// frame.

const ASPECT_WORD: Record<VideoAspect, string> = {
  "16:9": "Landscape",
  "9:16": "Portrait",
};

export function GenerateVideoPanel({ projectId }: { projectId: string }) {
  const readOnly = useEditor((s) => s.readOnly);
  const signedIn = useSignedIn();
  const allJobs = useGenerate((s) => s.jobs);
  // Panel renders only — a chat- or scene-owned job lives on its chat card.
  const jobs = allJobs.filter((j) => j.projectId === projectId && j.kind === "video" && !j.chatId);
  const { prompt, refs, character, aspect } = useVideoGen();
  const candidates = useRefCandidates();
  // OS files handed to the panel — dropped on it or pasted into the prompt —
  // attach as references (media files import into the project on the way;
  // text files ride as-is).
  const attachFiles = (files: File[]) =>
    void refsFromDroppedFiles(projectId, files).then((refs) => {
      for (const r of refs) useVideoGen.getState().addRef(r);
    });
  const { active: dropActive, attachTarget, targetProps } = useAssetDrop(
    (ref) => useVideoGen.getState().addRef(ref),
    attachFiles
  );
  const [tier, setTier] = useLocalPref<VideoModelOption["tier"]>(
    "cut-gen-tier",
    "omni",
    (v) => VIDEO_MODELS.some((m) => m.tier === v)
  );

  // Every knob renders from — and is clamped to — what the selected model
  // supports, so a stored pick from another model can never reach the API.
  const model = VIDEO_MODELS.find((m) => m.tier === tier) ?? VIDEO_MODELS[0];
  const effAspect = nearestAspect(aspect, model.aspects);

  // Default the shape to the project's own orientation when the panel opens,
  // same as the image panel (the user can still pick the other one). A custom
  // project ratio seeds the closest shape the model renders.
  useEffect(() => {
    useVideoGen
      .getState()
      .setAspect(nearestAspect(useEditor.getState().aspect, model.aspects));
    // eslint-disable-next-line react-hooks/exhaustive-deps -- mount-time seed only
  }, []);

  const go = () => {
    const { text, refs: all } = collectRefs(prompt.trim(), refs, candidates);
    if (!text) return;
    // Character mode: the text is the spoken line — compose it with the
    // persona, and seed the render with the character's poster frame so the
    // same person delivers it.
    const composed = character?.persona ? characterPrompt(character.persona, text) : text;
    const seedRefs = character ? [refFromStockVideo(character)] : all;
    void useGenerate.getState().generateVideo(projectId, composed, {
      aspect: effAspect,
      refs: seedRefs,
      // The character's poster seed is the point — the same person must
      // deliver the line — so free-form prompts alone get the ref rewrite.
      composeRefs: !character,
    }).settled;
    useVideoGen.getState().openWith("");
  };

  return (
    <>
      <div className="flex h-12 shrink-0 items-center justify-between pr-2.5 pl-4">
        <span className="text-sm font-semibold tracking-tight">Generate video</span>
      </div>

      <ScrollArea
        ref={attachTarget}
        {...targetProps}
        className="min-h-0 flex-1"
        contentClassName="flex flex-col gap-3 px-3.5 pb-4"
      >
        {!readOnly && (<>
        {/* Composer: the character and attached references ride inside the
            input box, above the prompt — same shape as the image panel, which
            also highlights this box while a drag hovers the panel. */}
        <div
          className={cn(
            "relative flex shrink-0 flex-col rounded-lg border border-input focus-within:border-ring",
            dropActive && "border-[#0a84ff] ring-2 ring-[#0a84ff]/30 ring-inset"
          )}
        >
          {character && (
            <div className="gen-character flex items-center gap-2 p-2 pb-0">
              {/* eslint-disable-next-line @next/next/no-img-element -- bundled static thumb on a client-only page */}
              <img
                src={character.thumb}
                alt={stockTitle(character.id)}
                className="size-8 shrink-0 rounded-md object-cover"
              />
              <span className="min-w-0 flex-1 truncate text-[12px] font-medium">
                {stockTitle(character.id)}
              </span>
              <button
                title="Leave character mode"
                className="grid size-6 shrink-0 place-items-center rounded-full text-muted-foreground hover:text-foreground"
                onClick={() => useVideoGen.getState().clearCharacter()}
              >
                <X className="size-3.5" />
              </button>
            </div>
          )}
          <RefChips
            refs={refs}
            onRemove={(ref) => useVideoGen.getState().removeRef(ref)}
            onUpdate={(ref) => useVideoGen.getState().updateRef(ref)}
            className="p-2 pb-0"
            peekSide="bottom"
          />
          <MentionTextarea
            className="gen-prompt min-h-[88px] w-full resize-y bg-transparent px-2.5 py-2 pr-9 text-[12.5px] leading-relaxed outline-none"
            placeholder={
              character
                ? "What should they say?"
                : "A drone shot rising over a foggy coastline at sunrise… Drop media in or type @ to reference it."
            }
            value={prompt}
            onChange={(v) => useVideoGen.getState().setPrompt(v)}
            candidates={candidates}
            submitKey="mod-enter"
            menuSide="bottom"
            onSubmit={go}
            attachedRefs={refs}
            onUpsertRef={(r) => useVideoGen.getState().updateRef(r)}
            onPasteFiles={attachFiles}
            onRemoveLastRef={() => {
              const last = refs[refs.length - 1];
              if (last) useVideoGen.getState().removeRef(last);
            }}
          />
          <DictationControl
            text={prompt}
            onResult={(v) => useVideoGen.getState().setPrompt(v)}
            buttonClassName="absolute right-2 bottom-2 bg-background/70 backdrop-blur-sm"
          />
        </div>

        {/* Which model renders the clip — a dropdown, since the catalog grows.
            The model renders the whole clip with audio in one pass and picks
            its own length, so aspect below is the only other knob. */}
        <PillSelect
          className="h-7 shrink-0"
          title="Model"
          value={tier}
          display={model.model}
          options={VIDEO_MODELS.map((m) => ({
            value: m.tier,
            // A tiered family reads "Fast · Model Fast"; a single-model
            // entry is just its name.
            label: m.word === m.model ? m.model : `${m.word} · ${m.model}`,
          }))}
          onChange={setTier}
        />

        {/* Shape, the same pill family as the image panel. */}
        <PillSelect
          className="h-7 shrink-0"
          title="Aspect ratio"
          value={effAspect}
          display={ASPECT_WORD[effAspect]}
          options={model.aspects.map((a) => ({
            value: a,
            label: VIDEO_ASPECT_LABEL[a],
          }))}
          onChange={(v) => useVideoGen.getState().setAspect(v)}
        />

        <Button
          className="gen-go w-full shrink-0"
          disabled={!prompt.trim() || signedIn === false}
          onClick={go}
        >
          <Sparkles data-icon="inline-start" />
          Generate video
        </Button>

        {signedIn === false ? (
          <p className="gen-signin shrink-0 text-[11px] leading-relaxed text-muted-foreground">
            Generating runs on your Donkey account.{" "}
            <a className="font-medium text-blue-600 hover:underline dark:text-blue-400" href={signInUrl()}>
              Sign in
            </a>{" "}
            to continue.
          </p>
        ) : (
          <p className="shrink-0 text-[11px] leading-relaxed text-muted-foreground">
            Renders take a minute or two. Keep editing while it runs.
          </p>
        )}
        </>)}

        {jobs.length > 0 && (
          <div className="flex flex-col gap-1.5">
            {jobs.map((j) => (
              <JobRow
                key={j.id}
                job={j}
                handle={
                  candidates.find((c) => c.scope === "project" && c.id === j.assetId)?.handle
                }
              />
            ))}
          </div>
        )}
      </ScrollArea>
    </>
  );
}

/** A finished render is a full-width tile mirroring the image panel's
 * generated tiles: hover plays it (with sound), the prompt rides a bottom
 * gradient, and the actions overlay the corners. In-flight and failed jobs
 * stay a compact status row. */
function JobRow({ job, handle }: { job: GenerateJob; handle?: string }) {
  const asset = useEditor((s) => s.assets.find((a) => a.id === job.assetId));
  const readOnly = useEditor((s) => s.readOnly);
  const pulse = useGenPulse("video", job.assetId);
  const elapsed = useElapsed(job.status === "running" ? job.startedAt : null);
  const tileRef = useRef<HTMLDivElement>(null);
  const videoRef = useRef<HTMLVideoElement>(null);
  const { picked, pick } = useAssetPick(job.assetId ?? "");
  // Render history keeps every settled job; a preview loads only on screen.
  const [inViewRef, seen] = useInView<HTMLButtonElement>();

  if (job.status !== "done" || !asset) {
    return (
      <div className="gen-job group flex items-center gap-2.5 rounded-lg border border-border p-2">
        <span className="grid size-10 shrink-0 place-items-center rounded-md bg-muted text-muted-foreground">
          {job.status === "running" ? (
            <Loader2 className="size-4 animate-spin" />
          ) : (
            <Film className="size-4" />
          )}
        </span>
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
                Rendering…{" "}
                {elapsed && (
                  <span className="tabular-nums text-muted-foreground/80">{elapsed}</span>
                )}
              </>
            ) : (
              <HostedErrorText error={job.error} />
            )}
          </div>
        </div>
        {job.status !== "running" && (
          <div className="flex shrink-0 items-center gap-1">
            {job.status === "error" && !readOnly && (
              <button
                title="Retry"
                className={cardIconButton}
                onClick={() => useGenerate.getState().retry(job.id)}
              >
                <RotateCw className="size-3.5" />
              </button>
            )}
            <button
              title="Dismiss"
              className={cn(cardIconButton, "opacity-0 group-hover:opacity-100")}
              onClick={() => useGenerate.getState().dismiss(job.id)}
            >
              <X className="size-3.5" />
            </button>
          </div>
        )}
      </div>
    );
  }

  return (
    <div
      ref={tileRef}
      className={cn("gen-job group relative overflow-hidden rounded-lg", picked && PICKED_RING)}
      onMouseEnter={() => {
        const v = videoRef.current;
        if (!v) return;
        // Preview with sound; if the browser blocks unmuted autoplay, fall
        // back to a silent preview.
        v.muted = false;
        void v.play().catch(() => {
          v.muted = true;
          void v.play().catch(() => {});
        });
      }}
      onMouseLeave={() => {
        const v = videoRef.current;
        if (v) {
          v.pause();
          v.currentTime = 0.1;
          v.muted = true;
        }
      }}
    >
      <button
        ref={inViewRef}
        className="block w-full outline-none focus-visible:ring-2 focus-visible:ring-ring"
        draggable
        onDragStart={(e) => {
          setAssetDragData(e, asset.id);
          // Drag the rounded tile itself so the ghost keeps the video's corner
          // radius instead of the browser's square, white-framed default.
          if (tileRef.current) {
            const r = tileRef.current.getBoundingClientRect();
            e.dataTransfer.setDragImage(tileRef.current, e.clientX - r.left, e.clientY - r.top);
          }
        }}
        onDragEnd={clearAssetDrag}
        onClick={pick}
      >
        <video
          crossOrigin={MEDIA_CORS}
          ref={videoRef}
          muted
          loop
          playsInline
          preload="metadata"
          src={seen ? `${asset.url}#t=0.1` : undefined}
          className="aspect-[16/10] w-full bg-black object-cover"
        />
      </button>
      <CopyHandlePill handle={handle} name={asset.name} />
      <div className="pointer-events-none absolute inset-x-0 bottom-0 bg-gradient-to-t from-black/70 to-transparent px-2 py-1.5 opacity-0 transition-opacity group-hover:opacity-100">
        <span className="block truncate text-[11px] font-medium text-white">{job.prompt}</span>
      </div>
      <div className="absolute top-1 right-1 flex gap-1">
        <button
          title="Add to timeline"
          className="grid size-5 place-items-center rounded-full bg-primary text-primary-foreground opacity-0 transition-opacity group-hover:opacity-100 hover:brightness-110"
          onClick={() => useEditor.getState().addClipFromAsset(asset.id)}
        >
          <Plus className="size-3" />
        </button>
        <button
          title="Expand"
          className="grid size-5 place-items-center rounded-full bg-black/45 text-white opacity-0 transition-opacity group-hover:opacity-100 hover:bg-black/65"
          onClick={() =>
            useLightbox.getState().open({
              kind: "video",
              src: asset.url,
              name: asset.name,
              prompt: job.prompt,
              assetId: asset.id,
            })
          }
        >
          <Maximize2 className="size-3" />
        </button>
        <GeneratedAssetMenu
          asset={asset}
          projectId={job.projectId}
          triggerClassName="grid size-5 place-items-center rounded-full bg-black/45 text-white opacity-0 transition-opacity group-hover:opacity-100 data-popup-open:opacity-100 hover:bg-black/65"
          before={
            <>
              <DropdownMenuItem onClick={() => useVideoGen.getState().openWith(job.prompt)}>
                <Sparkles /> Use this prompt
              </DropdownMenuItem>
              <DropdownMenuItem
                onClick={() =>
                  void navigator.clipboard
                    .writeText(handle ? `@${handle}` : mentionToken(asset.name))
                    .catch(() => {})
                }
              >
                <Copy /> Copy reference
              </DropdownMenuItem>
            </>
          }
          onDelete={() => {
            // The render dies for real: the tile goes with its job row, and
            // the asset takes its media file (and any clips playing it)
            // along — same delete the image tiles offer.
            useGenerate.getState().dismiss(job.id);
            useEditor.getState().removeAsset(asset.id);
          }}
        />
      </div>
      {pulse && <div aria-hidden className={genPulseOverlay} />}
    </div>
  );
}
