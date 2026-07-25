"use client";

import { useEffect } from "react";
import { create } from "zustand";
import { getBackend, type CutBackend, type CutMode } from "./backend";
import { cloudBackend } from "./backend/cloud";
import { localBackend } from "./backend/local";
import type { AssetRef } from "./assetRef";
import { bytesFromBase64 } from "./bytes";
import { readThreadIds } from "./chatThreads";
import { composeGenPrompt, foldTextRefs } from "./composeGen";
import {
  projectWriteMode,
  removeRendersInDoc,
  stockAssetInDoc,
  upsertRenderInDoc,
} from "./genvideo/docWriter";
import { cutAppBase } from "./hosts";
import { hostedPost } from "./hosted";
import { enrichAsset, importFileToProject, uploadProjectImage } from "./media";
import { refsToInlineImages, videoSafeInline, visualRefs, type InlineImage } from "./refMedia";
import { useGenNotify } from "./genNotify";
import { useImageGen } from "./imageGen";
import { useEditor } from "./store";
import { mediaSlug, nearestAspect, type MediaAsset, type RenderRecord } from "./types";
import { videoModel } from "./videoModels";
import { walkLadder, type VideoAttempt } from "./videoLadder";

// AI generation jobs, held outside the panels so a tab switch (which unmounts
// them) doesn't orphan a running generation — video renders take minutes.
//
// Generation runs on Donkey's hosted inference routes with the user's Donkey
// sign-in and credits. The cut hosts serve the same Next app and the auth
// cookie rides the registrable domain, so these are plain same-origin calls.
// Finished media lands back in the project through the local engine: videos
// upload as regular files, images bake into still clips.

export interface GenerateJob {
  id: string;
  projectId: string;
  kind: "image" | "video";
  prompt: string;
  /** Epoch ms when the render started — live cards show a ticking elapsed. */
  startedAt: number;
  status: "running" | "done" | "error";
  error?: string;
  /** The project asset the finished generation landed as. */
  assetId?: string;
  /** The chat thread that launched this render, when it wasn't the panel.
   * An owned job shows on its chat card only — the Video/Image panels list
   * panel renders, so they skip it — and its asset lands chat-tagged. */
  chatId?: string;
  /** Stable identity of the work this render is FOR (a scene run's shot), so a
   * resumed caller re-adopts exactly its own in-flight job — never another
   * shot's that happens to share a prompt. */
  genKey?: string;
  /** The backend the job started on. Landing work can outlive navigation into
   * a project of the other residency, so every project write for this job pins
   * here instead of reading the (rebound) global mode at land time. */
  residency?: CutMode;
  /** Which ladder rung landed the render (0-based index into the attempts) —
   * how a caller knows whether its take rode an image anchor. */
  rung?: number;
  /** The provider poll payload for an in-flight render — persisting it is what
   * lets a reload re-attach to the running job instead of orphaning it. */
  poll?: {
    id: string;
    provider: string;
    model: string;
    providerJobId?: string | null;
    providerGenerationId?: string | null;
    providerPollingUrl?: string | null;
    metadata?: Record<string, unknown>;
  };
}

/** A render's initial submission outcome, distinct from its settlement: `ok`
 * once the backend accepts the render (it is genuinely in flight, still minutes
 * from landing), or the reason when the submit is rejected outright — auth,
 * credits, a bad request — before any render started. Lets a caller claim the
 * render is underway only when it actually is, never on an instant reject. */
export type VideoSubmitOutcome = { ok: true } | { ok: false; error: string };

interface GenerateState {
  /** Whether a Donkey session exists; null = not probed yet. */
  signedIn: boolean | null;
  jobs: GenerateJob[];
  probe: () => void;
  /** Awaitable probe, for callers that must know before acting (the AI
   * assistant's generate tools); resolves the fresh signed-in answer. */
  probeNow: () => Promise<boolean>;
  /** Kick off a generation. Returns when it settles, resolving to the final
   * job (status "done" with assetId, or "error" with a message) so the AI
   * assistant can act on the result; the panel just fires and forgets.
   * `refs` are references of any kind — images upload as-is, videos by a
   * captured poster frame, text files by their contents folded into the
   * prompt (see composeGen.ts). */
  generateImage: (
    projectId: string,
    prompt: string,
    opts?: {
      refs?: AssetRef[];
      aspect?: "16:9" | "9:16" | "1:1";
      resolution?: "1K" | "2K" | "4K";
      /** Rewrite the prompt around the references before rendering (the
       * default when refs are present) — see composeGen.ts. */
      composeRefs?: boolean;
      /** The owning chat thread when chat (or a scene run) asked — stamps the
       * job and the landed asset, keeping both off the generate panels. */
      chatId?: string;
    }
  ) => Promise<GenerateJob>;
  /** Kick off a video render. Returns the job id right away (the render
   * outlives most callers) plus the settled job for anyone who waits. */
  generateVideo: (
    projectId: string,
    prompt: string,
    opts?: VideoGenOptions
  ) => { jobId: string; settled: Promise<GenerateJob>; submitted: Promise<VideoSubmitOutcome> };
  /** Kick off a video render that walks an identity ladder: ONE job spans the
   * attempts in order, and a failed rung submits the next instead of failing
   * the job — so a safety-blocked or rejected anchor degrades the render
   * instead of killing it. An empty balance stops the walk (every rung would
   * fail the same way). Both the scene pipeline's shots and chat's one-off
   * renders run on this, so the two have identical fallback behavior. */
  generateVideoLadder: (
    projectId: string,
    attempts: VideoAttempt[],
    jobOpts?: {
      chatId?: string;
      genKey?: string;
      onDone?: (asset: MediaAsset) => void;
      /** Called as each rung starts (0-based) — progress narration. */
      onAttempt?: (rung: number) => void;
    }
  ) => { jobId: string; settled: Promise<GenerateJob>; submitted: Promise<VideoSubmitOutcome> };
  dismiss: (id: string) => void;
  /** Cancel every render owned by a deleted thread or project: matching jobs are
   * dropped from the list and their in-flight polls refuse to land, so a render
   * still running when the user deletes its owner can't re-add media afterward.
   * Called by thread deletion (chatId) and project deletion (projectId). */
  cancelForOwner: (owner: { chatId?: string; projectId?: string }) => void;
  /** Re-attach the poll loop of every persisted running render (reload
   * recovery) — called once when the app boots. Idempotent. */
  resumeRunningJobs: () => void;
}

export interface VideoGenOptions {
  /** Composition shape; defaults to the project's orientation. */
  aspect?: "16:9" | "9:16";
  /** What the render must avoid — the wrong medium's tells, letterbox bars,
   * on-screen text. The model has no negative-prompt parameter, so the
   * adapter folds this into the prompt as an avoid clause. */
  negativePrompt?: string;
  /** References of any kind — video, image, text file. The model takes one
   * seed image, so at most one picture seeds the render as its literal
   * opening frame. */
  refs?: AssetRef[];
  /** Identity anchors (up to the registry's maxReferenceImages): the render
   * keeps these characters/objects/scenes consistent instead of playing one
   * as the first frame. Mutually exclusive with a `refs` image seed; the
   * prompt rides as written (no compose rewrite). */
  referenceImages?: AssetRef[];
  /** Rewrite the prompt around the references before rendering (the
   * default when refs are present) — see composeGen.ts. The model plays the
   * input image as the literal first frame, so a prompt that transforms
   * the reference must become a standalone description with the image
   * dropped; the rewrite decides which. Character mode passes false — the
   * poster seed is the point. */
  composeRefs?: boolean;
  /** Called once with the landed asset when the render completes and the
   * project is still open — lets the AI place the clip after a background
   * render it couldn't wait out (the assistant tool bridge caps at 2min). */
  onDone?: (asset: MediaAsset) => void;
  /** The owning chat thread when chat (or a scene run) asked — stamps the
   * job and the landed asset, keeping both off the generate panels. */
  chatId?: string;
  /** Stable identity of the work this render is for — see GenerateJob.genKey. */
  genKey?: string;
}

export type { VideoAttempt } from "./videoLadder";

const REFRESH_MS = 8000;
const VIDEO_DEADLINE_MS = 12 * 60_000;

const uid = () => crypto.randomUUID().slice(0, 8);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** The backend a job's results land on: its pinned residency; jobs persisted
 * before residency existed fall back to the active backend. */
const jobBackend = (job: { residency?: CutMode }): CutBackend =>
  job.residency === "cloud" ? cloudBackend : job.residency === "local" ? localBackend : getBackend();

/** Display name for the asset: the prompt, tidied and capped. */
const promptName = (prompt: string) => {
  const line = prompt.trim().replace(/\s+/g, " ");
  return line.length > 60 ? `${line.slice(0, 57)}…` : line;
};

/** The Donkey sign-in URL, same-host, returning to the Cut page the user
 * started from. Image, video, and voiceover all run on the user's Donkey
 * account, so every generation surface links here when signed out. */
export function signInUrl(): string {
  if (typeof window === "undefined") return "/sign-in";
  return `/sign-in?callbackURL=${encodeURIComponent(window.location.href)}`;
}

/** Shown for any 402 (empty balance) across chat and generation tiles. The
 * chat error box and the job tiles match this text to swap in a "reload here"
 * credits link, so keep it and those call sites in sync. */
export const NO_CREDITS_MESSAGE = "No credits left";

/** Cut's billing page, where credits are bought — same-host on every host via
 * the app link base. Linked from any generation error caused by an empty
 * balance. */
export function creditsUrl(): string {
  if (typeof window === "undefined") return "/cut/app/settings";
  return `${cutAppBase(window.location.host)}/settings`;
}

/** Creation-time ownership for generated media, in one place so the rule can't
 * drift per call site: chat-owned media lives on its chat card — never a
 * generate-panel row or arrival badge — and everything else is a panel render
 * (origin "generated", so it stays out of the Media panel's user imports). */
export function applyOwnership(asset: MediaAsset, chatId: string | undefined | null): void {
  if (chatId) {
    asset.origin = "chat";
    asset.chatId = chatId;
  } else {
    asset.origin = "generated";
  }
}

interface GenerationOutput {
  dataBase64?: string;
  contentType?: string;
  filename?: string;
  url?: string;
}

interface GenerationResponse {
  id: string;
  status: string;
  provider: string;
  model: string;
  providerJobId: string | null;
  providerGenerationId: string | null;
  providerPollingUrl: string | null;
  outputs: GenerationOutput[];
  error?: unknown;
  metadata?: Record<string, unknown>;
}

async function readError(res: Response, fallback: string): Promise<string> {
  if (res.status === 401) return "Sign in to Donkey to generate media.";
  const body = (await res.json().catch(() => null)) as {
    error?: unknown;
    message?: unknown;
    details?: { message?: unknown } | null;
  } | null;
  const message = [body?.message, body?.error].find(
    (v): v is string => typeof v === "string" && v.length > 0
  );
  if (res.status === 402) return NO_CREDITS_MESSAGE;
  // The provider tucks the real reason (a safety block, a rejected prompt) under
  // details.message; the top-level message is only a generic headline. Append it so a
  // failure explains itself instead of stopping at "…generation failed."
  const detail =
    typeof body?.details?.message === "string" && body.details.message.trim()
      ? body.details.message.trim()
      : null;
  if (detail && detail !== message) return message ? `${message} ${detail}` : detail;
  return message ?? fallback;
}

const providerError = (error: unknown): string | null => {
  if (typeof error === "string" && error) return error;
  if (error && typeof error === "object" && "message" in error) {
    const m = (error as { message?: unknown }).message;
    if (typeof m === "string" && m) return m;
  }
  return null;
};

/** Resolve a generation's prompt + input images from its refs. Runs the shared
 * compose step (see composeGen.ts) unless the caller opted out; on a compose
 * failure, falls back to the visual refs as-is with text-ref contents folded
 * into the prompt. `maxImages` caps what the generator accepts (video: 1 seed). */
async function promptAndImages(
  target: "video" | "image",
  prompt: string,
  refs: AssetRef[],
  compose: boolean,
  maxImages: number
): Promise<{ prompt: string; images: InlineImage[] }> {
  if (refs.length === 0) return { prompt, images: [] };
  if (compose) {
    const composed = await composeGenPrompt(target, prompt, refs);
    if (composed) return { prompt: composed.prompt, images: composed.images.slice(0, maxImages) };
  }
  return {
    prompt: await foldTextRefs(prompt, refs),
    images: await refsToInlineImages(visualRefs(refs).slice(0, maxImages)),
  };
}

/** Video jobs persist per browser: settled ones so an unplaced render (a chat
 * card, the Video panel's renders list) survives a reload, and running ones
 * with their provider poll payload so a reload RE-ATTACHES to the in-flight
 * render (resumeRunningJobs) instead of orphaning credits already spent. A
 * running job persisted without a payload (it died before the provider
 * answered) restores as an error. */
const JOBS_KEY = "cut-gen-video-jobs";
const JOBS_CAP = 50;

/** Awaitable settlements for in-flight renders, fresh and reload-resumed —
 * how a resumed caller (the scene pipeline) adopts a running job's result
 * instead of billing a second take. */
const settlements = new Map<string, Promise<GenerateJob>>();

/** The settled-job promise for a running render, when this session owns it. */
export function videoJobSettlement(jobId: string): Promise<GenerateJob> | undefined {
  return settlements.get(jobId);
}

function readPersistedJobs(): GenerateJob[] {
  try {
    const v = JSON.parse(localStorage.getItem(JOBS_KEY) ?? "[]") as unknown;
    if (!Array.isArray(v)) return [];
    return (v as GenerateJob[])
      .filter((j) => j?.id)
      .map((j) =>
        j.status === "running" && !j.poll
          ? { ...j, status: "error" as const, error: "Interrupted by a reload before the render started." }
          : j
      );
  } catch {
    return [];
  }
}

function persistJobs(jobs: GenerateJob[]) {
  try {
    localStorage.setItem(
      JOBS_KEY,
      JSON.stringify(
        jobs
          .filter((j) => j.kind === "video" && (j.status !== "running" || j.poll))
          .slice(0, JOBS_CAP)
      )
    );
  } catch {
    // Storage full/blocked — render history just won't persist.
  }
}

// Exactly one browser tab polls (and lands) a given render. Persisted running
// jobs are visible to every tab of the origin, so each job carries a lease in
// localStorage: the owning tab renews it on every poll, and another tab takes
// over only once the lease has gone stale (the owner closed or crashed).
const TAB_ID = crypto.randomUUID().slice(0, 8);
const LEASE_TTL_MS = 30_000;
const leaseKey = (jobId: string) => `cut-gen-lease-${jobId}`;

/** Take (or renew) the poll lease for a job. False when a live sibling tab
 * holds it. Storage failures grant the lease — a tab that can't read storage
 * can't see other tabs' leases either, and single-tab correctness wins. */
function claimJobLease(jobId: string): boolean {
  try {
    const raw = localStorage.getItem(leaseKey(jobId));
    if (raw) {
      const lease = JSON.parse(raw) as { tab?: string; at?: number };
      if (lease.tab !== TAB_ID && Date.now() - (lease.at ?? 0) < LEASE_TTL_MS) return false;
    }
    localStorage.setItem(leaseKey(jobId), JSON.stringify({ tab: TAB_ID, at: Date.now() }));
    return true;
  } catch {
    return true;
  }
}

function releaseJobLease(jobId: string): void {
  try {
    localStorage.removeItem(leaseKey(jobId));
  } catch {
    // Stale lease expires on its own TTL.
  }
}

export const useGenerate = create<GenerateState>((set, get) => {
  // A single session probe is in flight at a time, but the answer stays
  // re-checkable for the page's whole life: a sign-in can complete in another
  // tab, or the session cookie can land a beat after this page loads.
  let probing: Promise<boolean> | null = null;

  // Jobs whose owner (thread or project) was deleted mid-render. Their poll loop
  // checks this before landing anything, so a render that finishes after its
  // owner is gone drops its result instead of re-adding orphaned media.
  const cancelledJobs = new Set<string>();

  // Chat-launched video renders mirror into the project doc (doc.renders): the
  // job store is per browser, the doc travels with the project, so the mirror
  // is what makes the chat's render card show the same outcome everywhere.
  // Open project → the store (autosave persists it); closed → its doc.
  const mirrorRender = (id: string) => {
    const j = get().jobs.find((x) => x.id === id);
    if (!j || j.kind !== "video" || !j.chatId) return;
    const record: RenderRecord = {
      id: j.id,
      chatId: j.chatId,
      prompt: j.prompt,
      startedAt: j.startedAt,
      status: j.status,
      ...(j.error !== undefined ? { error: j.error } : {}),
      ...(j.assetId !== undefined ? { assetId: j.assetId } : {}),
    };
    const backend = jobBackend(j);
    void (async () => {
      if ((await projectWriteMode(j.projectId)) === "store")
        useEditor.getState().upsertRender(record);
      else await upsertRenderInDoc(j.projectId, record, backend);
    })().catch(() => {});
  };

  const unmirrorRenders = (projectId: string, victims: GenerateJob[]) => {
    const mirrored = victims.filter((j) => j.kind === "video" && j.chatId);
    if (mirrored.length === 0) return;
    const ids = mirrored.map((j) => j.id);
    const backend = jobBackend(mirrored[0]);
    void (async () => {
      if ((await projectWriteMode(projectId)) === "store")
        useEditor.getState().removeRenders(ids);
      else await removeRendersInDoc(projectId, ids, backend);
    })().catch(() => {});
  };

  const update = (id: string, patch: Partial<GenerateJob>) => {
    set((s) => ({ jobs: s.jobs.map((j) => (j.id === id ? { ...j, ...patch } : j)) }));
    persistJobs(get().jobs);
    // Poll-payload and rung refreshes stay browser-local; only record-visible
    // fields re-mirror.
    if ("status" in patch || "assetId" in patch || "error" in patch) mirrorRender(id);
  };

  const fail = (id: string, err: unknown) =>
    update(id, { status: "error", error: err instanceof Error ? err.message : String(err) });

  // The job after it has settled, for callers that awaited the run.
  const settled = (id: string, fallback: GenerateJob): GenerateJob =>
    get().jobs.find((j) => j.id === id) ?? fallback;

  // The media file exists either way. The open project records it in the live
  // store; a closed one records it in its persisted doc so nothing the render
  // made is orphaned. Returns whether the OPEN project adopted it (badges and
  // placement callbacks only make sense on screen).
  const adopt = (projectId: string, asset: MediaAsset, backend?: CutBackend): boolean => {
    if (useEditor.getState().projectId !== projectId) {
      void stockAssetInDoc(projectId, asset, backend).catch(() => {});
      return false;
    }
    useEditor.getState().addAsset(asset);
    void enrichAsset(asset);
    return true;
  };

  /** Poll an in-flight video render to completion and land its file as a project
   * asset — the shared tail of a fresh render and a reload-resumed one. Keeps
   * the job's poll payload fresh so the NEXT reload re-attaches too. */
  const finishVideo = async (
    jobId: string,
    first: GenerationResponse,
    onDone?: (asset: MediaAsset) => void,
    since?: number
  ): Promise<void> => {
    const job = get().jobs.find((j) => j.id === jobId);
    if (!job) return;
    let gen = first;
    // The render is abandoned once its owner is deleted: cancelForOwner drops the
    // job from the list, so a vanished job (or one flagged mid-render) means stop
    // polling and land nothing — the media it would have added is unwanted.
    const aborted = () => cancelledJobs.has(jobId) || !get().jobs.some((j) => j.id === jobId);
    // A resumed render keeps its original deadline, floored so a reload near
    // the limit still gets a couple of polls before giving up. A ladder rung
    // passes its own start so a slow first rung doesn't starve the fallback.
    const deadline = Math.max((since ?? job.startedAt) + VIDEO_DEADLINE_MS, Date.now() + 2 * 60_000);
    while (gen.status === "in_progress") {
      if (aborted()) return;
      claimJobLease(jobId); // renewed every cycle; siblings back off until it staled
      update(jobId, {
        poll: {
          id: gen.id,
          provider: gen.provider,
          model: gen.model,
          providerJobId: gen.providerJobId,
          providerGenerationId: gen.providerGenerationId,
          providerPollingUrl: gen.providerPollingUrl,
          metadata: gen.metadata ?? {},
        },
      });
      if (Date.now() > deadline) throw new Error("The video render is taking too long — try again.");
      await sleep(REFRESH_MS);
      const poll = await hostedPost("/api/inference/assets/refresh", {
        id: gen.id,
        kind: "video",
        provider: gen.provider,
        model: gen.model,
        providerJobId: gen.providerJobId,
        providerGenerationId: gen.providerGenerationId,
        providerPollingUrl: gen.providerPollingUrl,
        metadata: gen.metadata ?? {},
      });
      if (!poll.ok) throw new Error(await readError(poll, "Video generation failed."));
      gen = (await poll.json()) as GenerationResponse;
    }
    if (gen.status !== "completed") {
      throw new Error(providerError(gen.error) ?? "Video generation failed.");
    }
    // Owner deleted while the render finished: skip the import entirely so no
    // file is even written for media nobody will ever see.
    if (aborted()) return;

    const out = gen.outputs.find((o) => o.dataBase64) ?? gen.outputs.find((o) => o.url);
    const fileName = `ai-${mediaSlug(job.prompt, "generated")}.mp4`;
    let file: File;
    if (out?.dataBase64) {
      file = new File([bytesFromBase64(out.dataBase64)], fileName, {
        type: out.contentType ?? "video/mp4",
      });
    } else if (out?.url) {
      const dl = await fetch(out.url);
      if (!dl.ok) throw new Error("Could not download the generated video.");
      file = new File([await dl.arrayBuffer()], fileName, {
        type: out.contentType ?? "video/mp4",
      });
    } else {
      throw new Error("The provider returned no video.");
    }

    const backend = jobBackend(job);
    const asset = await importFileToProject(job.projectId, file, backend);
    if (!asset) throw new Error("Could not import the generated video.");
    // The owner may have been deleted during the import (the file write is a
    // round trip): drop the file we just wrote rather than leave it orphaned.
    if (aborted()) {
      void backend
        .fetch(`/api/cut/projects/${job.projectId}/media/${encodeURIComponent(asset.fileName)}`, {
          method: "DELETE",
        })
        .catch(() => {});
      return;
    }
    asset.name = promptName(job.prompt);
    applyOwnership(asset, job.chatId);
    if (adopt(job.projectId, asset, backend)) {
      if (!job.chatId) useGenNotify.getState().landed("video", asset.id);
      onDone?.(asset);
    }
    update(jobId, { status: "done", assetId: asset.id, poll: undefined });
  };

  return {
    signedIn: null,
    jobs: typeof window === "undefined" ? [] : readPersistedJobs(),

    probe: () => {
      void get().probeNow();
    },

    probeNow: () => {
      probing ??= fetch("/api/auth/get-session", { cache: "no-store" })
        .then((r) => (r.ok ? r.json() : null))
        .then((s) => {
          const signedIn = Boolean((s as { user?: unknown } | null)?.user);
          set({ signedIn });
          return signedIn;
        })
        // A transient failure shouldn't knock a known session back to signed-out;
        // only fall to false when we never learned otherwise.
        .catch(() => {
          const signedIn = get().signedIn ?? false;
          set({ signedIn });
          return signedIn;
        })
        .finally(() => {
          probing = null;
        });
      return probing;
    },

    generateImage: (projectId, prompt, opts) => {
      const backend = getBackend(); // pinned: the render outlives navigation
      const job: GenerateJob = {
        id: uid(),
        projectId,
        kind: "image",
        prompt,
        startedAt: Date.now(),
        status: "running",
        residency: backend.kind,
        ...(opts?.chatId ? { chatId: opts.chatId } : {}),
      };
      set((s) => ({ jobs: [job, ...s.jobs] }));
      return (async () => {
        try {
          const aspect =
            opts?.aspect ??
            nearestAspect(useEditor.getState().aspect, ["16:9", "9:16", "1:1"] as const);
          const resolution = opts?.resolution ?? useImageGen.getState().resolution;
          // The job (and the landed asset's name) keeps the user's own words;
          // only the render sees the composed prompt. The image model takes
          // several input images, so every kept reference rides along.
          const { prompt: sent, images } = await promptAndImages(
            "image",
            prompt,
            opts?.refs ?? [],
            opts?.composeRefs !== false,
            Infinity
          );
          const res = await hostedPost("/api/inference/assets", {
            kind: "image",
            prompt: sent,
            ...(images.length > 0 ? { inputs: { images } } : {}),
            // The image model takes a real frame + detail via imageConfig; no prompt steering.
            parameters: { aspectRatio: aspect, imageSize: resolution },
          });
          if (!res.ok) throw new Error(await readError(res, "Image generation failed."));
          const gen = (await res.json()) as GenerationResponse;
          const out = gen.outputs.find((o) => o.dataBase64);
          if (!out?.dataBase64) throw new Error("The provider returned no image.");

          // Mark it generated so it surfaces in the generate panel; a stock
          // image imported from a tile sends no origin (plain import).
          const asset = await uploadProjectImage(
            projectId,
            new Blob([bytesFromBase64(out.dataBase64)], {
              type: out.contentType ?? "image/png",
            }),
            out.filename ?? "image.png",
            {
              name: promptName(prompt),
              origin: "generated",
              failMessage: "Could not add the image to the project.",
              backend,
            }
          );
          // Owner deleted while the image rendered (cancelForOwner dropped the
          // job): drop the baked file instead of adopting orphaned media.
          if (cancelledJobs.has(job.id) || !get().jobs.some((j) => j.id === job.id)) {
            void backend
              .fetch(`/api/cut/projects/${projectId}/media/${encodeURIComponent(asset.fileName)}`, {
                method: "DELETE",
              })
              .catch(() => {});
            return settled(job.id, job);
          }
          applyOwnership(asset, opts?.chatId);
          if (adopt(projectId, asset, backend) && !opts?.chatId) {
            useGenNotify.getState().landed("image", asset.id);
          }
          update(job.id, { status: "done", assetId: asset.id });
        } catch (err) {
          fail(job.id, err);
        }
        return settled(job.id, job);
      })();
    },

    generateVideo: (projectId, prompt, opts) =>
      get().generateVideoLadder(projectId, [{ prompt, opts }], {
        ...(opts?.chatId ? { chatId: opts.chatId } : {}),
        ...(opts?.genKey ? { genKey: opts.genKey } : {}),
        ...(opts?.onDone ? { onDone: opts.onDone } : {}),
      }),

    generateVideoLadder: (projectId, attempts, jobOpts) => {
      // The job (and the landed asset's name) keeps the caller's first-rung
      // words; only the render sees each rung's composed prompt.
      const job: GenerateJob = {
        id: uid(),
        projectId,
        kind: "video",
        prompt: attempts[0]?.prompt ?? "",
        startedAt: Date.now(),
        status: "running",
        residency: getBackend().kind, // pinned: the render outlives navigation
        ...(jobOpts?.chatId ? { chatId: jobOpts.chatId } : {}),
        ...(jobOpts?.genKey ? { genKey: jobOpts.genKey } : {}),
      };
      set((s) => ({ jobs: [job, ...s.jobs] }));
      claimJobLease(job.id); // this tab started it, this tab polls it
      mirrorRender(job.id);

      // Resolves the moment the backend accepts a rung's submit (a real render
      // is in flight) or, if every rung is rejected before acceptance, with the
      // reason. A caller awaits this to distinguish "rendering" from a render
      // that never started (auth, credits, a bad request reject in well under a
      // second) instead of claiming success on a fire-and-forget kickoff.
      let resolveSubmitted!: (outcome: VideoSubmitOutcome) => void;
      const submitted = new Promise<VideoSubmitOutcome>((resolve) => {
        resolveSubmitted = resolve;
      });
      let submitReported = false;
      const reportSubmit = (outcome: VideoSubmitOutcome) => {
        if (submitReported) return;
        submitReported = true;
        resolveSubmitted(outcome);
      };

      /** Compose and submit one rung's render request; resolves the provider's
       * first response (usually in_progress) or throws the readable error. */
      const submitRung = async ({ prompt, opts }: VideoAttempt): Promise<GenerationResponse> => {
        // The model seeds from a single first-frame image, so at most one kept
        // picture rides along. Identity anchors travel separately: with
        // referenceImages set, the prompt stands as written and no seed image
        // rides (the render takes one or the other).
        // Every picture riding to the video model goes through videoSafeInline:
        // it takes only JPEG/PNG, and a webp reference would fail the render
        // after it was already billed.
        const anchors = opts?.referenceImages?.length
          ? await Promise.all(
              (
                await refsToInlineImages(
                  visualRefs(opts.referenceImages).slice(0, videoModel("omni").maxReferenceImages)
                )
              ).map(videoSafeInline)
            )
          : [];
        const { prompt: sent, images: rawImages } = anchors.length
          ? { prompt, images: [] as InlineImage[] }
          : await promptAndImages("video", prompt, opts?.refs ?? [], opts?.composeRefs !== false, 1);
        const images = await Promise.all(rawImages.map(videoSafeInline));
        const res = await hostedPost("/api/inference/assets", {
          kind: "video",
          prompt: sent,
          provider: "gemini-omni",
          ...(anchors.length > 0
            ? { inputs: { referenceImages: anchors } }
            : images.length > 0
              ? { inputs: { images } }
              : {}),
          parameters: {
            aspectRatio:
              opts?.aspect ?? nearestAspect(useEditor.getState().aspect, ["16:9", "9:16"] as const),
            ...(opts?.negativePrompt ? { negativePrompt: opts.negativePrompt } : {}),
          },
        });
        if (!res.ok) throw new Error(await readError(res, "Video generation failed."));
        return (await res.json()) as GenerationResponse;
      };

      const settledRun = (async () => {
        try {
          const outcome = await walkLadder(
            attempts,
            async (attempt, rung) => {
              jobOpts?.onAttempt?.(rung);
              // The rung persists as the attempt starts, not when the walk
              // settles — a reload that adopts this in-flight job must still
              // know which rung (anchored or not) produced the take.
              update(job.id, { rung });
              const gen = await submitRung(attempt);
              // The backend took the submit — a render is genuinely in flight
              // now (instant rejects throw above and never reach here). A later
              // polling failure still fails the job, but it did start.
              reportSubmit({ ok: true });
              await finishVideo(job.id, gen, jobOpts?.onDone, Date.now());
            },
            {
              // The next rung is a fresh submission: drop the dead rung's poll
              // payload so a reload can't resume a render that already failed.
              onRungFailed: () => update(job.id, { poll: undefined }),
              // An empty balance fails every rung identically — stop there so
              // a broke render fails fast, not once per rung.
              fatal: (error) => error === NO_CREDITS_MESSAGE,
            }
          );
          if (!outcome.ok) fail(job.id, new Error(outcome.error));
        } finally {
          releaseJobLease(job.id);
          // No rung was ever accepted: the render never started, so report the
          // submit as failed with the job's recorded reason. A no-op once an
          // accepted rung already reported success.
          const errored = get().jobs.find((x) => x.id === job.id);
          reportSubmit({ ok: false, error: errored?.error ?? "Video generation failed." });
        }
        return settled(job.id, job);
      })();
      settlements.set(job.id, settledRun);
      return { jobId: job.id, settled: settledRun, submitted };
    },

    cancelForOwner: (owner) => {
      const match = (j: GenerateJob) =>
        (owner.chatId !== undefined && j.chatId === owner.chatId) ||
        (owner.projectId !== undefined && j.projectId === owner.projectId);
      const victims = get().jobs.filter(match);
      if (victims.length === 0) return;
      // Flag the running ones so their poll loop lands nothing (finishVideo reads
      // cancelledJobs), then drop every matching job — running or settled, its
      // card belonged to the owner the user just deleted.
      for (const j of victims) {
        cancelledJobs.add(j.id);
        releaseJobLease(j.id);
      }
      set((s) => ({ jobs: s.jobs.filter((j) => !match(j)) }));
      persistJobs(get().jobs);
      // The mirrored records go with the owner — except on project deletion,
      // where the whole doc is going away anyway.
      if (owner.projectId === undefined) {
        const byProject = new Map<string, GenerateJob[]>();
        for (const j of victims) {
          byProject.set(j.projectId, [...(byProject.get(j.projectId) ?? []), j]);
        }
        for (const [projectId, group] of byProject) unmirrorRenders(projectId, group);
      }
    },

    resumeRunningJobs: () => {
      const stored = new Map(readPersistedJobs().map((j) => [j.id, j]));
      // Read each project's surviving thread ids once per sweep.
      const threadCache = new Map<string, Set<string>>();
      const threadIds = (projectId: string) => {
        let ids = threadCache.get(projectId);
        if (!ids) {
          ids = readThreadIds(projectId);
          threadCache.set(projectId, ids);
        }
        return ids;
      };
      for (const j of get().jobs) {
        // A render whose owning thread no longer exists — the thread was deleted,
        // or its whole project was (which clears the project's threads) — must
        // never land: drop it so a reload can't resurrect media the user removed.
        if (j.chatId && !threadIds(j.projectId).has(j.chatId)) {
          get().dismiss(j.id);
          continue;
        }
        if (j.kind !== "video" || j.status !== "running" || !j.poll || settlements.has(j.id)) continue;
        // Storage is the cross-tab truth: a sibling tab may have settled this
        // render already — adopt its outcome instead of re-polling (and
        // re-importing) a finished job.
        const theirs = stored.get(j.id);
        if (theirs && theirs.status !== "running") {
          set((s) => ({ jobs: s.jobs.map((x) => (x.id === j.id ? theirs : x)) }));
          continue;
        }
        // Another live tab is already polling this render — landing it twice
        // would import the file twice. The boot sweep re-runs on an interval,
        // so if that tab closes, its lease stales and this one takes over.
        if (!claimJobLease(j.id)) continue;
        const poll = j.poll;
        const run = (async () => {
          try {
            // Re-enter the poll loop where the last session left it. The
            // timeline placement callback (onDone) is a closure and cannot
            // survive a reload — the asset still lands on its card/panel.
            await finishVideo(j.id, {
              status: "in_progress",
              outputs: [],
              ...poll,
            } as GenerationResponse);
          } catch (err) {
            fail(j.id, err);
          } finally {
            releaseJobLease(j.id);
          }
          return settled(j.id, j);
        })();
        settlements.set(j.id, run);
      }
    },

    dismiss: (id) => {
      const victim = get().jobs.find((j) => j.id === id);
      set((s) => ({ jobs: s.jobs.filter((j) => j.id !== id) }));
      persistJobs(get().jobs);
      if (victim) unmirrorRenders(victim.projectId, [victim]);
    },
  };
});

// Reload recovery: re-attach every persisted in-flight render as soon as the
// app boots, so a refresh never orphans credits already spent. The sweep
// repeats so a render whose owning tab closed (its lease staled) is picked up
// by a surviving tab instead of orphaned; resumeRunningJobs itself is
// idempotent and lease-guarded, so the repeats are cheap no-ops otherwise.
if (typeof window !== "undefined") {
  setTimeout(() => useGenerate.getState().resumeRunningJobs(), 0);
  setInterval(() => useGenerate.getState().resumeRunningJobs(), LEASE_TTL_MS);
}

/** Donkey sign-in state for the generation surfaces. Probes on mount and again
 * whenever the tab regains focus, so signing in — in this tab's round trip or a
 * separate tab — flips the UI without a manual reload. Null until first known. */
export function useSignedIn(): boolean | null {
  const signedIn = useGenerate((s) => s.signedIn);
  useEffect(() => {
    const probe = () => useGenerate.getState().probe();
    probe();
    const onVisible = () => {
      if (document.visibilityState === "visible") probe();
    };
    window.addEventListener("focus", probe);
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      window.removeEventListener("focus", probe);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, []);
  return signedIn;
}
