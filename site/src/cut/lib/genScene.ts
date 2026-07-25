"use client";

import { create } from "zustand";
import { apiFetch, apiJson } from "./backend";
import { useGenerate } from "./generate";
import { realSuite } from "./genvideo/adapters";
import { GEN_FPS, StoreEditorBridge } from "./genvideo/editorBridge";
import { VideoOrchestrator } from "./genvideo/orchestrator";
import { onActivity } from "./genvideo/activity";
import { projectWriteMode, withProjectDoc } from "./genvideo/docWriter";
import type { RefAsset, Shot, VideoEvent, VideoPhase, VideoProject } from "./genvideo/types";
import { useEditor } from "./store";
import type { Aspect } from "./types";

// Brief-to-video ("generate a video") controller. It owns one VideoOrchestrator
// per open project and runs it browser-side, exactly where generation and the
// editor store live. The orchestrator plans up to the shot breakdown and stops
// (the confirmation gate); the user approves, then the shots render and land on
// the timeline live. State persists on ProjectDoc.genvideo, so a reload resumes
// a run in flight.
//
// Held outside the panels (like useGenerate) so switching tabs never orphans a
// multi-minute render.

export type SceneStatus = "planning" | "awaiting_approval" | "generating" | "done" | "failed";

export interface SceneFeedItem {
  at: number;
  text: string;
  /** Project asset this entry produced — the feed shows its thumbnail. */
  mediaId?: string;
  /** The work item this entry narrates (a sheet, a shot). A new keyed entry
   * retires the item's previous in-progress lines, so "Designing Mason…"
   * gives way to "Designed Mason" instead of both lingering. Entries with
   * media are milestones and always stay. */
  key?: string;
}

export interface SceneRun {
  projectId: string;
  /** The chat thread that asked — the card renders in that thread alone. */
  chatId?: string | null;
  mode: "generated" | "provided";
  /** What the run is about, for the card heading. */
  title: string;
  status: SceneStatus;
  phase: VideoPhase;
  shots: Shot[];
  placed: number;
  total: number;
  /** The run's chronological record — every step it narrated and every asset
   * it made (sheets, frames, takes), rendered in the chat card in order. */
  feed: SceneFeedItem[];
  error?: string;
  /** When the run began (planning), for the elapsed clock. */
  startedAt: number;
  /** When rendering began (approval) — the render timer counts from here, not
   * from the idle time spent at the confirmation gate. */
  renderStartedAt?: number;
  /** When the run reached done/failed, freezing the elapsed clock. */
  endedAt?: number;
}

/** M:SS for an elapsed millisecond span. */
export function formatDuration(ms: number): string {
  const t = Math.max(0, Math.floor(ms / 1000));
  return `${Math.floor(t / 60)}:${String(t % 60).padStart(2, "0")}`;
}

export interface StartSceneParams {
  brief?: string;
  fromAudioAssetId?: string;
  targetSeconds?: number;
  aspect?: Aspect;
  style?: string;
  referenceAssetIds?: string[];
  /** The chat thread that asked, so the run's media is tagged to it and stays
   * off the Media/Video/Image/Audio panels. */
  chatId?: string | null;
}

// Live orchestrators, one per project. Kept out of zustand state so their
// identity churn never triggers a render; the reactive `run` mirror follows
// the OPEN project only. A run keeps rendering when the user switches away —
// its placements land in the project's persisted doc (see StoreEditorBridge)
// and the mirror re-attaches when they come back.
const orchestrators = new Map<string, VideoOrchestrator>();

useEditor.subscribe((s, prev) => {
  // The card mirrors the open project's run only; the orchestrator itself
  // keeps working in the background.
  if (s.projectId !== prev.projectId) {
    const run = useGenScene.getState().run;
    if (run && run.projectId !== s.projectId) useGenScene.setState({ run: null });
  }
  // Once a project finishes loading: re-attach the mirror to its live run, or
  // resume its persisted plan. This lives on the store, not a component, so a
  // paid run resumes (and its media re-tags) even when the AI panel never
  // mounts. loadProject flips `loaded` false→true in the same set() that
  // fills genvideo, so the edge fires once per open.
  if (!s.loaded || prev.loaded || !s.projectId) return;
  // A shared view shows the owner's persisted run as data only — never
  // adopt or resume it (resuming would render on the viewer's account).
  if (s.readOnly) return;
  const live = orchestrators.get(s.projectId);
  if (live && !live.isAborted && !isTerminal(statusFor(live.project))) {
    // The run is still working: its clips loaded as ordinary content — re-mark
    // them render-owned, then mirror the live run. A run that FINISHED while
    // the project was closed falls through instead: its clips belong to the
    // user's undo domain now, and adopting them here would scrub them out of
    // every history snapshot with nothing left to release them.
    const owned = runClipIds(live.project);
    useEditor.getState().adoptGenClips(owned.clipIds, owned.audioIds);
    mirrorRun(s.projectId, live.project);
    return;
  }
  if (!s.genvideo) return;
  if (useGenScene.getState().run?.projectId === s.projectId) return;
  useGenScene.getState().hydrate(s.projectId, s.genvideo);
});

// Boot sweep: a reload must not strand a paid run in a project the user
// doesn't happen to reopen. Every project whose persisted plan is mid-render
// resumes headless — placements land in its doc, and opening the project
// attaches the progress card to the already-running orchestrator. Only
// approved plans resume (the user already okayed the spend); a plan waiting
// at the gate keeps waiting for its user.
//
// killedChats closes the race between this sweep and a thread deletion: the
// sweep builds orchestrators seconds after boot, so killThread may run before
// the run it should kill exists. The tombstone is checked at adoption, and
// killThread also sweeps the persisted docs itself, so a deleted thread's run
// can never resume behind the conversation the user destroyed.
const killedChats = new Set<string>();
let backgroundSweepDone = false;
async function resumeBackgroundRuns(): Promise<void> {
  try {
    if (!(await useGenerate.getState().probeNow())) return; // renders need the sign-in
    const res = await apiFetch("/api/cut/projects");
    const list = await apiJson<{ id: string }[]>(res);
    if (!res.ok || !Array.isArray(list)) return;
    for (const p of list) {
      if (!p?.id || orchestrators.has(p.id)) continue;
      if (useEditor.getState().projectId === p.id) continue; // the open project hydrates via its own load
      const docRes = await apiFetch(`/api/cut/projects/${p.id}`).catch(() => null);
      if (!docRes?.ok) continue;
      const doc = (await docRes.json()) as { genvideo?: VideoProject | null };
      const plan = doc.genvideo;
      if (!plan) continue;
      if (plan.chatId && killedChats.has(plan.chatId)) {
        killRun(p.id); // the owning thread died before this run was adopted
        continue;
      }
      if (plan.phase === "done" || plan.phase === "failed" || !plan.breakdownApproved) continue;
      // Re-check both guards after the awaits: the user may have opened this
      // project mid-fetch, and its own load then hydrates an orchestrator —
      // a second one here would render (and bill) every shot twice.
      if (orchestrators.has(p.id) || useEditor.getState().projectId === p.id) continue;
      const orch = buildOrchestrator(p.id, plan);
      orchestrators.set(p.id, orch);
      orch.run().then(settled(p.id, orch)).catch(failed(p.id, orch));
    }
  } catch {
    // Headless resume is best-effort — the hosted page has no engine, and a
    // run it can't reach resumes the next time its project opens.
  } finally {
    backgroundSweepDone = true;
  }
}
if (typeof window !== "undefined") {
  setTimeout(() => void resumeBackgroundRuns(), 1500);
}

const FEED_CAP = 200;
const CONCURRENCY = 3; // gentle on the video model's rate limit

const uid = () => crypto.randomUUID().slice(0, 8);
const isTerminal = (s: SceneStatus) => s === "done" || s === "failed";

/** The doc half of killThread: a dead thread's runs may live in closed
 * projects with no orchestrator (the boot sweep builds them lazily), so the
 * persisted plans are swept directly — otherwise a reload, or the sweep
 * itself, resumes and bills a run whose conversation no longer exists. */
async function killPersistedThreadRuns(chatId: string): Promise<void> {
  try {
    const res = await apiFetch("/api/cut/projects");
    const list = await apiJson<{ id: string }[]>(res);
    if (!res.ok || !Array.isArray(list)) return;
    for (const p of list) {
      if (!p?.id || orchestrators.has(p.id)) continue; // handled by the live pass
      if (useEditor.getState().projectId === p.id) continue; // ditto (store-backed)
      const docRes = await apiFetch(`/api/cut/projects/${p.id}`).catch(() => null);
      if (!docRes?.ok) continue;
      const doc = (await docRes.json()) as { genvideo?: VideoProject | null };
      if (doc.genvideo?.chatId === chatId) killRun(p.id);
    }
  } catch {
    // Best-effort: the tombstone still blocks this session's sweep from
    // resuming the run, and the next delete attempt sweeps again.
  }
}

/** Kill a project's run outright: the orchestrator stops spending, the
 * persisted plan clears (so no reload resumes it), and whatever it already
 * placed belongs to the user as ordinary timeline content. */
function killRun(projectId: string): void {
  orchestrators.get(projectId)?.abort();
  orchestrators.delete(projectId);
  if (useEditor.getState().projectId === projectId) {
    useEditor.getState().setGenvideo(undefined);
    useEditor.getState().releaseGenClips();
  } else {
    void withProjectDoc(projectId, (doc) => {
      doc.genvideo = undefined;
    }).catch(() => {});
  }
  const run = useGenScene.getState().run;
  if (run?.projectId === projectId) useGenScene.setState({ run: null });
}

/** Whether a chat thread owns a run that is still working (or waiting at the
 * gate) — the history cap retains such threads, so pruning never kills work.
 * Until the boot sweep has adopted every background run, the orchestrators map
 * is not the whole truth, so every thread counts as live-run-owning: pruning
 * must never kill work it simply hasn't seen yet. */
export function threadHasLiveRun(chatId: string): boolean {
  if (!backgroundSweepDone) return true;
  for (const orch of orchestrators.values()) {
    if (orch.project.chatId === chatId && !orch.isAborted && !isTerminal(statusFor(orch.project)))
      return true;
  }
  return false;
}

/** Build a persistable RefAsset list from project asset ids the user pointed at.
 * Tagged "style" so they anchor both the reference images and every shot. */
function toReferences(ids: string[] | undefined): RefAsset[] {
  if (!ids?.length) return [];
  const assets = useEditor.getState().assets;
  const out: RefAsset[] = [];
  for (const id of ids) {
    const a = assets.find((x) => x.id === id);
    if (a) out.push({ mediaId: a.id, kind: a.type, purpose: "style", name: a.name });
  }
  return out;
}

function newProject(projectId: string, params: StartSceneParams): VideoProject {
  const audio = params.fromAudioAssetId
    ? useEditor.getState().assets.find((a) => a.id === params.fromAudioAssetId && a.type === "audio")
    : undefined;
  const mode: "generated" | "provided" = audio ? "provided" : "generated";
  return {
    id: `scene-${uid()}`,
    brief: params.brief?.trim() ?? "",
    references: toReferences(params.referenceAssetIds),
    audioMode: mode,
    ...(audio ? { audioAssetId: audio.id } : {}),
    ...(params.targetSeconds ? { targetSeconds: params.targetSeconds } : {}),
    fps: GEN_FPS,
    durationFrames: audio ? Math.round(audio.duration * GEN_FPS) : 0,
    transcript: [],
    // The plan owns its shape from the start (start() applies params.aspect to
    // an empty timeline before this runs), so a background render can never
    // pick up another open project's aspect.
    aspect: useEditor.getState().aspect,
    style: params.style?.trim() ?? "",
    suiteLabel: "donkey-hosted",
    ...(params.chatId ? { chatId: params.chatId } : {}),
    characters: [],
    locations: [],
    shots: [],
    phase: mode === "generated" ? "brief" : "ingest",
    breakdownApproved: false,
    createdAt: Date.now(),
    updatedAt: 0,
  };
}

/** The run's placed timeline clip ids (video track + soundtrack), including
 * clips a re-cut replaced that still hold their slots. */
function runClipIds(project: VideoProject): { clipIds: string[]; audioIds: string[] } {
  const clipIds = project.shots
    .flatMap((s) => [s.timelineClipId, ...(s.replacesClipIds ?? [])])
    .filter((x): x is string => !!x);
  const audioIds = [
    ...(project.beatVoices ?? []).map((b) => b.voiceClipId),
    project.musicClipId,
  ].filter((x): x is string => !!x);
  return { clipIds, audioIds };
}

/** Every project asset id a run created (never the user's own references). */
function runAssetIds(project: VideoProject): Set<string> {
  const ids = new Set<string>();
  for (const sh of project.shots) {
    for (const id of [sh.startKeyframe, sh.clip, sh.voiceAssetId]) {
      if (id) ids.add(id);
    }
  }
  for (const bv of project.beatVoices ?? []) if (bv.voiceAssetId) ids.add(bv.voiceAssetId);
  if (project.musicAssetId) ids.add(project.musicAssetId);
  for (const va of [...project.characters, ...project.locations]) {
    if (va.mediaId) ids.add(va.mediaId);
  }
  return ids;
}

/** Re-assert chat ownership over everything a run created. New renders are
 * owned from creation (the chatId rides the generate job), but a run persisted
 * before that — or one whose asset landed while its project wasn't open — can
 * leave keyframes, shots, or narration sitting in the generate panels. Run on
 * hydrate, this re-tags those assets to the run's chat thread and drops any
 * panel job rows the run left behind (an errored render never landed an asset,
 * so its row is matched by the shot prompt it rendered). */
function claimRunMedia(projectId: string, project: VideoProject): void {
  const chatId = project.chatId;
  if (!chatId) return;
  const ids = runAssetIds(project);
  const editor = useEditor.getState();
  for (const a of editor.assets) {
    if (ids.has(a.id) && (a.origin !== "chat" || a.chatId !== chatId)) {
      editor.updateAsset(a.id, { origin: "chat", chatId });
    }
  }
  const prompts = new Set(
    project.shots.map((sh) => sh.lastPrompt).filter((p): p is string => !!p)
  );
  for (const j of useGenerate.getState().jobs) {
    if (j.chatId) continue; // already owned — the panels never saw it
    // Scoped to the run's own project: a prompt string alone must never match
    // (and delete) a render the user made themselves elsewhere.
    if (j.projectId !== projectId) continue;
    if ((j.assetId && ids.has(j.assetId)) || prompts.has(j.prompt)) {
      useGenerate.getState().dismiss(j.id);
    }
  }
}

/** The feed line a phase change reads as, when it has one. */
function phaseActivity(phase: VideoPhase): string | undefined {
  switch (phase) {
    case "brief": return "Writing the script…";
    case "ingest": return "Listening to the audio…";
    case "breakdown": return "Cutting the narration into shots…";
    case "voicing": return "Voicing the narration…";
    case "style": return "Designing the look, cast, and places…";
    case "keyframes": return "Drawing each shot's opening frame…";
    case "storyboard": return "Storyboard ready — review the frames before rendering.";
    case "generating": return "Rendering shots…";
    case "polish": return "Assembling the final cut…";
    default: return undefined;
  }
}

/** The feed line a transient shot status reads as (`n` is 1-based). The
 * terminal statuses (placed/failed) enter the feed as milestones with media
 * in applyEvent instead. */
function shotActivity(shot: Shot, n: number): string | undefined {
  switch (shot.status) {
    case "keyframing": return `Shot ${n} — drawing the opening frame…`;
    case "generating": return shot.attempts > 1 ? `Shot ${n} — retake ${shot.attempts}…` : `Shot ${n} — rendering…`;
    case "lipsync": return `Shot ${n} — syncing lips to the narration…`;
    case "reviewing": return `Shot ${n} — screening the take against the plan…`;
    default: return undefined;
  }
}

/** Fold an orchestrator event into the reactive run mirror. */

function applyEvent(projectId: string, e: VideoEvent): void {
  useGenScene.setState((s) => {
    if (!s.run || s.run.projectId !== projectId) return s;
    const run = { ...s.run };
    // Every event becomes a feed entry (consecutive repeats collapse), so the
    // chat activity reads as the run's chronological record, assets included.
    // A keyed entry retires its work item's earlier in-progress lines;
    // entries with media are milestones and always stay.
    const note = (text: string, mediaId?: string, key?: string) => {
      const last = run.feed[run.feed.length - 1];
      if (last && last.text === text && last.mediaId === mediaId) return;
      const kept = key ? run.feed.filter((f) => f.key !== key || f.mediaId) : run.feed;
      run.feed = [
        ...kept,
        { at: Date.now(), text, ...(mediaId ? { mediaId } : {}), ...(key ? { key } : {}) },
      ].slice(-FEED_CAP);
    };
    switch (e.type) {
      case "phase": {
        const line = phaseActivity(e.phase);
        if (line) note(line);
        run.phase = e.phase;
        break;
      }
      case "breakdown":
        run.shots = e.shots;
        run.total = e.shots.length;
        note(`Shot plan ready — ${e.shots.length} shot${e.shots.length === 1 ? "" : "s"}.`);
        break;
      case "shot:update": {
        // Milestones enter the record with their media; transient statuses
        // (rendering, retakes, review) narrate as plain lines.
        const prev = run.shots.find((sh) => sh.id === e.shot.id);
        run.shots = run.shots.map((sh) => (sh.id === e.shot.id ? e.shot : sh));
        const n = run.shots.findIndex((sh) => sh.id === e.shot.id) + 1;
        if (n > 0) {
          const key = `shot:${e.shot.id}`;
          if (e.shot.startKeyframe && prev?.startKeyframe !== e.shot.startKeyframe)
            note(`Shot ${n} — opening frame designed`, e.shot.startKeyframe, key);
          if (e.shot.status === "placed" && prev?.status !== "placed" && e.shot.clip)
            note(`Shot ${n} — take placed on the timeline`, e.shot.clip, key);
          if (e.shot.status === "failed" && prev?.status !== "failed")
            note(`Shot ${n} — couldn't animate, holding a still`, e.shot.startKeyframe, key);
          const line = e.shot.status !== prev?.status ? shotActivity(e.shot, n) : undefined;
          if (line) note(line, undefined, key);
        }
        break;
      }
      case "progress":
        run.placed = e.placed;
        run.total = e.total;
        break;
      case "log":
        note(e.message);
        break;
      case "asset":
        note(e.label, e.mediaId, e.key);
        break;
      case "activity":
        note(e.message, undefined, e.key);
        break;
      case "error":
        note(e.message);
        run.error = e.message;
        break;
    }
    return { run };
  });
}

// Adapter sub-steps ("Drawing pose 3/6…") arrive over the activity bus — the
// adapters have no emit channel of their own. A scoped message updates only
// its own project's card; a background run stays silent on screen.
onActivity((message, projectId) => {
  useGenScene.setState((s) => {
    if (!s.run || s.run.endedAt) return s;
    if (projectId && s.run.projectId !== projectId) return s;
    // Sub-steps are part of the run's record too — the card's feed lists
    // them chronologically (consecutive repeats collapse).
    const last = s.run.feed[s.run.feed.length - 1];
    const feed =
      last?.text === message
        ? s.run.feed
        : [...s.run.feed, { at: Date.now(), text: message }].slice(-FEED_CAP);
    return { run: { ...s.run, feed } };
  });
});

/** Map the orchestrator's persisted project phase to a card status. */
function statusFor(p: VideoProject): SceneStatus {
  if (p.phase === "failed") return "failed";
  if (p.phase === "done") return "done";
  if (p.breakdownApproved) return "generating";
  // Unapproved: the approval gate opens only at the storyboard phase, once the
  // frames are drawn and story-checked. Anything earlier (writing, designing,
  // drawing frames) is still planning — an Approve button before the frames
  // exist would offer to render a storyboard nobody has seen.
  return p.phase === "storyboard" ? "awaiting_approval" : "planning";
}

/** Reconstruct the feed a reload lost: the assets the run already made, in
 * production order — cast/location sheets first, then each shot's opening
 * frame and take. Live events append from here. */
function seedFeed(p: VideoProject): SceneFeedItem[] {
  const at = p.createdAt || 0;
  const items: SceneFeedItem[] = [];
  for (const va of [...p.characters, ...p.locations]) {
    if (va.mediaId) items.push({ at, text: `Designed ${va.name}`, mediaId: va.mediaId });
  }
  p.shots.forEach((sh, i) => {
    if (sh.startKeyframe)
      items.push({ at, text: `Shot ${i + 1} — opening frame designed`, mediaId: sh.startKeyframe });
    if (sh.status === "placed" && sh.clip)
      items.push({ at, text: `Shot ${i + 1} — take placed on the timeline`, mediaId: sh.clip });
    if (sh.status === "failed")
      items.push({
        at,
        text: `Shot ${i + 1} — couldn't animate, holding a still`,
        ...(sh.startKeyframe ? { mediaId: sh.startKeyframe } : {}),
      });
  });
  return items;
}

/** Point the reactive mirror at a live run's current state (project re-open).
 * The clock anchors come from the plan itself, so elapsed time is the run's
 * real working time, not time-since-this-mirror. */
function mirrorRun(projectId: string, p: VideoProject): void {
  useGenScene.setState({
    run: {
      projectId,
      chatId: p.chatId ?? null,
      mode: p.audioMode,
      title: p.brief || "Animating your audio",
      status: statusFor(p),
      phase: p.phase,
      shots: p.shots,
      placed: p.shots.filter((s) => s.timelineClipId).length,
      total: p.shots.length,
      feed: seedFeed(p),
      startedAt: p.createdAt || Date.now(),
      ...(statusFor(p) === "generating"
        ? { renderStartedAt: p.renderStartedAt ?? Date.now() }
        : {}),
      // A terminal run's mirror is a record, not a live surface: endedAt
      // freezes the clock (at the plan's stamped end, so the elapsed shown is
      // the run's real working time) and stops the activity bus appending to
      // its feed. Plans from before end-stamping clamp to 0:00.
      ...(isTerminal(statusFor(p))
        ? {
            ...(p.renderStartedAt ? { renderStartedAt: p.renderStartedAt } : {}),
            endedAt: p.endedAt ?? p.renderStartedAt ?? Date.now(),
          }
        : {}),
    },
  });
}

function syncFromProject(projectId: string): void {
  const p = orchestrators.get(projectId)?.project;
  if (!p) return;
  const status = statusFor(p);
  useGenScene.setState((s) => {
    if (!s.run || s.run.projectId !== projectId) return s;
    const terminal = status === "done" || status === "failed";
    return {
      run: {
        ...s.run,
        phase: p.phase,
        shots: p.shots,
        total: p.shots.length,
        status,
        ...(terminal ? { endedAt: Date.now() } : {}),
      },
    };
  });
  // A finished run hands its clips to the user's undo domain — from here they
  // edit (and undo) like anything else. A regeneration adopts them back first.
  if ((status === "done" || status === "failed") && useEditor.getState().projectId === projectId) {
    useEditor.getState().releaseGenClips();
  }
}

function fail(projectId: string, message: string): void {
  useGenScene.setState((s) =>
    s.run && s.run.projectId === projectId
      ? { run: { ...s.run, status: "failed", error: message, endedAt: Date.now() } }
      : s
  );
  // Failed is terminal — whatever the run placed belongs to the user now.
  if (useEditor.getState().projectId === projectId) useEditor.getState().releaseGenClips();
}

/** Settle handlers scoped to one orchestrator: a superseded run's late
 * resolution must never touch the run mirror — by the time it settles, the
 * project's slot may belong to a fresh run. */
function settled(projectId: string, orch: VideoOrchestrator): () => void {
  return () => {
    if (orchestrators.get(projectId) === orch && !orch.isAborted) syncFromProject(projectId);
  };
}
function failed(projectId: string, orch: VideoOrchestrator): (e: unknown) => void {
  return (e) => {
    if (orchestrators.get(projectId) === orch && !orch.isAborted) {
      fail(projectId, e instanceof Error ? e.message : String(e));
    }
  };
}

/** Rebuild a finished run from the open project's persisted plan so the
 * revision tools keep working after a reload. Built on demand — a done card
 * resurfaces only when the user actually revises, never just from opening the
 * project. Returns true once a live orchestrator and mirror exist. */
function resumeDoneRun(): boolean {
  const ed = useEditor.getState();
  const stored = ed.genvideo;
  if (!ed.projectId || !stored || stored.phase !== "done") return false;
  // Reviving the run re-opens its card; a stale dismissal must not hide the
  // record of the work about to happen on the next load.
  const project = { ...stored, cardDismissed: undefined };
  if (stored.cardDismissed) ed.setGenvideo(project);
  orchestrators.get(ed.projectId)?.abort();
  const orch = buildOrchestrator(ed.projectId, project);
  orchestrators.set(ed.projectId, orch);
  mirrorRun(ed.projectId, project);
  return true;
}

function buildOrchestrator(projectId: string, project: VideoProject): VideoOrchestrator {
  return new VideoOrchestrator(project, {
    editor: new StoreEditorBridge(projectId),
    // project.chatId (persisted) owns the run's media, so tagging survives a
    // reload/resume, not just the initial turn.
    suite: realSuite(projectId, project.chatId),
    emit: (e) => applyEvent(projectId, e),
    // Persist through the open store when this run's project is on screen
    // (autosave carries it), else straight into the project's doc — a run
    // keeps its plan durable wherever the user is. Routed through
    // projectWriteMode so a plan save never races a load's doc fetch.
    persist: async (p) => {
      if ((await projectWriteMode(projectId)) === "store") {
        useEditor.getState().setGenvideo(p);
        return;
      }
      return withProjectDoc(projectId, (doc) => {
        doc.genvideo = { ...p };
      }).catch(() => {});
    },
    concurrency: CONCURRENCY,
  });
}

interface GenSceneState {
  run: SceneRun | null;
  /** Plan a video and stop at the confirmation gate. Resolves once the shot
   * list is ready (or the run fails). */
  start: (
    projectId: string,
    params: StartSceneParams
  ) => Promise<{ started: boolean; shotCount?: number; message: string }>;
  /** Approve the shot plan — the shots render in the background from here. */
  approve: () => { ok: boolean; message: string };
  /** Redo one shot (1-based), optionally nudging it ("wider", "at night"). */
  regenerateShot: (n: number, note?: string) => { ok: boolean; message: string };
  /** Re-cut a contiguous span of shots (1-based, inclusive): replan just that
   * span against the same audio — it can become more shots or fewer — and
   * render only the new ones. The rest of the scene stays as it is. */
  recutShots: (fromN: number, toN: number, instruction: string) => { ok: boolean; message: string };
  /** Redo every shot holding a still in one go — the card's single retry
   * button after a credits top-up or a bad batch. */
  retryFailedShots: () => { ok: boolean; message: string };
  /** Restyle the whole scene and redo every shot. */
  restyle: (style: string) => { ok: boolean; message: string };
  /** Resume a FAILED run from where it stopped (the card's Retry). Failed is a
   * deliberate stop — nothing auto-resumes it — so this explicit click is the
   * only path that re-arms the plan and re-bills the missing work. */
  retryRun: () => { ok: boolean; message: string };
  /** Rebuild + resume a persisted run when a project loads. */
  hydrate: (projectId: string, project: VideoProject) => void;
  /** Stop the open project's run outright (chat's cancel_scene and the card's
   * stop both land here). */
  cancel: () => { ok: boolean; message: string };
  /** A chat thread was deleted — every run it owned dies with it. Nothing
   * keeps working behind a conversation the user killed. */
  killThread: (chatId: string) => void;
  /** A project was deleted — abort any live run so it stops spending and can't
   * write back to a doc that no longer exists. */
  killProject: (projectId: string) => void;
  dismiss: () => void;
}

export const useGenScene = create<GenSceneState>((set, get) => ({
  run: null,

  start: async (projectId, params) => {
    const cur = get().run;
    if (orchestrators.get(projectId) && cur && cur.projectId === projectId && !isTerminal(cur.status)) {
      return {
        started: false,
        message:
          "A video is already being generated for this project. Stop it with cancel_scene, or wait for it to finish.",
      };
    }
    // Validate before any side effect — the aspect apply below reshapes the
    // timeline and must not run for a request that gets rejected.
    if (!params.fromAudioAssetId && !params.brief?.trim()) {
      return { started: false, message: "Tell me what the video should be about." };
    }
    // Only set the aspect on an empty timeline: reframing a project that already
    // has clips is a committing edit, and this runs before the approval gate.
    // Applied before newProject so the plan freezes the effective shape.
    const ed = useEditor.getState();
    if (params.aspect && ed.clips.length === 0 && ed.audioClips.length === 0) {
      ed.setAspect(params.aspect);
    }
    const project = newProject(projectId, params);
    if (project.audioMode === "generated" && !project.brief) {
      return { started: false, message: "Tell me what the video should be about." };
    }
    // Supersede this project's previous run so two orchestrators never write
    // the same project at once; runs in other projects keep going.
    orchestrators.get(projectId)?.abort();
    const orch = buildOrchestrator(projectId, project);
    orchestrators.set(projectId, orch);
    set({
      run: {
        projectId,
        chatId: project.chatId ?? null,
        mode: project.audioMode,
        title: project.brief || "Animating your audio",
        status: "planning",
        phase: project.phase,
        shots: [],
        placed: 0,
        total: 0,
        feed: [],
        startedAt: Date.now(),
      },
    });
    try {
      await orch.run(); // resolves at the confirmation gate
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      failed(projectId, orch)(e);
      return { started: false, message };
    }
    if (orchestrators.get(projectId) !== orch || orch.isAborted) {
      return { started: false, message: "This plan was superseded before it finished." };
    }
    syncFromProject(projectId);
    const p = orch.project;
    if (p.phase === "failed") {
      return { started: false, message: get().run?.error ?? "Planning failed." };
    }
    return {
      started: true,
      shotCount: p.shots.length,
      message: `Planned ${p.shots.length} shot${p.shots.length === 1 ? "" : "s"}. Approve to render.`,
    };
  },

  approve: () => {
    const run = get().run;
    const orch = run ? orchestrators.get(run.projectId) : undefined;
    if (!orch || !run || run.status !== "awaiting_approval") {
      return { ok: false, message: "There's no video plan waiting to render." };
    }
    if (run.projectId !== useEditor.getState().projectId) {
      return { ok: false, message: "Open the plan's project to approve it." };
    }
    // Stamp the render start on the plan itself (approveBreakdown persists
    // it), so the card's clock survives reloads and project switches.
    orch.project.renderStartedAt = Date.now();
    set({ run: { ...run, status: "generating", renderStartedAt: Date.now() } });
    orch.approveBreakdown().then(settled(run.projectId, orch)).catch(failed(run.projectId, orch));
    return { ok: true, message: "Rendering — shots land on the timeline as they finish." };
  },

  regenerateShot: (n, note) => {
    const openId = useEditor.getState().projectId;
    if (!openId) return { ok: false, message: "Open a project first." };
    // At the storyboard gate, "redo" re-draws the opening frame only — the
    // cheap image, no take — and the run stays parked for approval. A note
    // ("at night", "wider") rides into the frame and the shot's plan.
    const gateRun = get().run;
    if (gateRun && gateRun.projectId === openId && gateRun.status === "awaiting_approval") {
      const orch = orchestrators.get(openId);
      const id = orch?.shotIdByNumber(n);
      if (!orch || !id) return { ok: false, message: `This scene has no shot ${n}.` };
      orch.reviseStoryboardFrame(id, note).catch(() => {});
      return { ok: true, message: note ? `Redrawing shot ${n} (${note})…` : `Redrawing shot ${n}…` };
    }
    // After a reload the finished run has no live orchestrator — rebuild it
    // from the persisted plan before deciding the scene "isn't done".
    if (!orchestrators.get(openId) || !get().run) resumeDoneRun();
    const run = get().run;
    const orch = orchestrators.get(openId);
    if (!orch || !run || run.status !== "done") {
      return { ok: false, message: "The scene isn't finished rendering yet — revise it once it's done." };
    }
    const id = orch.shotIdByNumber(n);
    if (!id) return { ok: false, message: `This scene has no shot ${n}.` };
    // The run takes its clips back for the redo (they were released at done),
    // so the swap stays off the undo stack until it finishes again.
    const owned = runClipIds(orch.project);
    useEditor.getState().adoptGenClips(owned.clipIds, owned.audioIds);
    set({ run: { ...run, status: "generating", renderStartedAt: Date.now() } });
    const redo = note ? orch.applyShotNote(id, note) : orch.regenerateShots([id]);
    redo.then(settled(run.projectId, orch)).catch(failed(run.projectId, orch));
    return { ok: true, message: `Redoing shot ${n}…` };
  },

  recutShots: (fromN, toN, instruction) => {
    // Same reload path as regenerateShot: a finished run rebuilds on demand.
    const openId = useEditor.getState().projectId;
    if (!openId) return { ok: false, message: "Open a project first." };
    if (!orchestrators.get(openId) || !get().run) resumeDoneRun();
    const run = get().run;
    const orch = orchestrators.get(openId);
    if (!orch || !run || run.status !== "done") {
      return { ok: false, message: "The scene isn't finished rendering yet — re-cut it once it's done." };
    }
    if (toN < fromN) return { ok: false, message: "to_shot must be at or after from_shot." };
    const ids: string[] = [];
    for (let n = fromN; n <= toN; n++) {
      const id = orch.shotIdByNumber(n);
      if (!id) return { ok: false, message: `This scene has no shot ${n}.` };
      ids.push(id);
    }
    // The run takes its clips back for the re-cut (they were released at
    // done), so the replacements stay off the undo stack until it finishes.
    const owned = runClipIds(orch.project);
    useEditor.getState().adoptGenClips(owned.clipIds, owned.audioIds);
    set({ run: { ...run, status: "generating", renderStartedAt: Date.now() } });
    orch.recutShots(ids, instruction).then(settled(run.projectId, orch)).catch(failed(run.projectId, orch));
    return {
      ok: true,
      message: fromN === toN ? `Re-cutting shot ${fromN}…` : `Re-cutting shots ${fromN}–${toN}…`,
    };
  },

  retryFailedShots: () => {
    // Same reload path as regenerateShot: a finished run rebuilds on demand.
    const openId = useEditor.getState().projectId;
    if (!openId) return { ok: false, message: "Open a project first." };
    if (!orchestrators.get(openId) || !get().run) resumeDoneRun();
    const run = get().run;
    const orch = orchestrators.get(openId);
    if (!orch || !run || run.status !== "done") {
      return { ok: false, message: "The scene isn't finished rendering yet — retry once it's done." };
    }
    const ids = orch.project.shots.filter((s) => s.status === "failed").map((s) => s.id);
    if (ids.length === 0) return { ok: false, message: "Every shot already rendered — nothing to retry." };
    // The run takes its clips back for the redo (they were released at done),
    // so the swaps stay off the undo stack until it finishes again.
    const owned = runClipIds(orch.project);
    useEditor.getState().adoptGenClips(owned.clipIds, owned.audioIds);
    set({ run: { ...run, status: "generating", renderStartedAt: Date.now() } });
    orch.regenerateShots(ids).then(settled(run.projectId, orch)).catch(failed(run.projectId, orch));
    return { ok: true, message: `Redoing ${ids.length} shot${ids.length === 1 ? "" : "s"}…` };
  },

  retryRun: () => {
    const openId = useEditor.getState().projectId;
    const stored = useEditor.getState().genvideo;
    if (!openId || !stored || stored.phase !== "failed") {
      return { ok: false, message: "No failed video run to retry here." };
    }
    // The retry re-opens the card; clear a stale dismissal so the revived
    // run's record survives the next load too.
    const plan = { ...stored, cardDismissed: undefined };
    if (stored.cardDismissed) useEditor.getState().setGenvideo(plan);
    orchestrators.get(openId)?.abort();
    const orch = buildOrchestrator(openId, plan);
    orchestrators.set(openId, orch);
    // The run takes its clips back while it works, same as a fresh render.
    const owned = runClipIds(plan);
    useEditor.getState().adoptGenClips(owned.clipIds, owned.audioIds);
    mirrorRun(openId, plan);
    set((s) =>
      s.run && s.run.projectId === openId
        ? {
            run: {
              ...s.run,
              status: plan.breakdownApproved ? ("generating" as const) : ("planning" as const),
              error: undefined,
              endedAt: undefined,
              renderStartedAt: Date.now(),
            },
          }
        : s
    );
    orch.retryFailed().then(settled(openId, orch)).catch(failed(openId, orch));
    return { ok: true, message: "Retrying the video run…" };
  },

  restyle: (style) => {
    // Same reload path as regenerateShot: a finished run rebuilds on demand.
    const openId = useEditor.getState().projectId;
    if (!openId) return { ok: false, message: "Open a project first." };
    if (!orchestrators.get(openId) || !get().run) resumeDoneRun();
    const run = get().run;
    const orch = orchestrators.get(openId);
    if (!orch || !run || run.status !== "done") {
      return { ok: false, message: "The scene isn't finished rendering yet — restyle it once it's done." };
    }
    // The run takes its clips back for the restyle (they were released at
    // done), so the swaps stay off the undo stack until it finishes again.
    const owned = runClipIds(orch.project);
    useEditor.getState().adoptGenClips(owned.clipIds, owned.audioIds);
    set({ run: { ...run, status: "generating", renderStartedAt: Date.now() } });
    orch.changeStyle(style).then(settled(run.projectId, orch)).catch(failed(run.projectId, orch));
    return { ok: true, message: "Restyling the whole scene…" };
  },

  hydrate: (projectId, project) => {
    // Re-assert chat ownership over the run's media before anything else, so
    // even a finished run's leftovers never sit in the generate panels.
    claimRunMedia(projectId, project);
    // A finished or failed run has nothing to resume — its clips are already
    // on the timeline — but its card is the run's durable record, so it
    // mirrors back on every load (no orchestrator, nothing spends) until the
    // user dismisses it; the X stamps the plan so the dismissal sticks.
    // Revision tools rebuild the live run on demand (resumeDoneRun).
    if (project.phase === "done" || project.phase === "failed") {
      if (!project.cardDismissed) mirrorRun(projectId, project);
      return;
    }
    // Rebuild the orchestrator around the persisted plan so approve/regenerate
    // keep working after a reload. Supersede this project's prior run first so
    // two never both write.
    orchestrators.get(projectId)?.abort();
    const orch = buildOrchestrator(projectId, project);
    orchestrators.set(projectId, orch);
    // The store's gen sets reset on load; re-mark this in-flight run's already
    // placed clips as render-owned so undo/redo stay off them as it finishes.
    const owned = runClipIds(project);
    useEditor.getState().adoptGenClips(owned.clipIds, owned.audioIds);
    set({
      run: {
        projectId,
        chatId: project.chatId ?? null,
        mode: project.audioMode,
        title: project.brief || "Animating your audio",
        status: statusFor(project),
        phase: project.phase,
        shots: project.shots,
        placed: project.shots.filter((s) => s.timelineClipId).length,
        total: project.shots.length,
        feed: seedFeed(project),
        // The plan carries its own clock anchors, so a resumed run shows its
        // real working time instead of restarting from zero.
        startedAt: project.createdAt || Date.now(),
        ...(statusFor(project) === "generating"
          ? { renderStartedAt: project.renderStartedAt ?? Date.now() }
          : {}),
      },
    });
    // A run interrupted mid-generation picks itself back up, and one
    // interrupted mid-planning finishes its plan (run() stops at the gate by
    // construction); only a completed plan sitting at the gate waits.
    if (project.breakdownApproved || statusFor(project) === "planning") {
      orch.run().then(settled(projectId, orch)).catch(failed(projectId, orch));
    }
  },

  cancel: () => {
    const run = get().run;
    if (!run || isTerminal(run.status)) {
      return { ok: false, message: "No video generation is running." };
    }
    killRun(run.projectId);
    return { ok: true, message: "Stopped. Anything already placed stays on the timeline." };
  },

  killThread: (chatId) => {
    // Deleting a chat deletes its work: every run the thread owned aborts, and
    // its persisted plan clears so no reload resumes it (or strands a card no
    // thread can show). Clips the run already placed stay on the timeline as
    // ordinary content. The tombstone covers the runs this pass can't see yet
    // — a background run the boot sweep hasn't adopted — and the doc sweep
    // below clears their persisted plans.
    killedChats.add(chatId);
    // Stop the thread's in-flight video renders too: aborting the orchestrator
    // ends the scene loop, but each shot's render polls on its own in useGenerate
    // and would otherwise land its clip under the dead thread minutes later.
    useGenerate.getState().cancelForOwner({ chatId });
    for (const [projectId, orch] of orchestrators) {
      if (orch.project.chatId === chatId) killRun(projectId);
    }
    const open = useEditor.getState();
    if (open.projectId && open.genvideo?.chatId === chatId) killRun(open.projectId);
    const run = get().run;
    if (run?.chatId === chatId) set({ run: null });
    void killPersistedThreadRuns(chatId);
  },

  killProject: (projectId) => {
    // The project (folder, doc, media) is being deleted: abort a live scene run
    // so it stops spending and never writes back to a doc that's gone. The
    // persisted plan needs no clearing — it dies with the project folder.
    const orch = orchestrators.get(projectId);
    if (orch) {
      orch.abort();
      orchestrators.delete(projectId);
    }
    const run = get().run;
    if (run?.projectId === projectId) set({ run: null });
  },

  dismiss: () => {
    const run = get().run;
    // Dismissing an unrendered plan abandons it: the orchestrator stops and
    // the persisted plan is cleared, so it can't resurrect on the next load.
    // A finished (or failed) run keeps its record — its media re-tags from it
    // on load — but the dismissal is stamped on the plan so the card stays
    // closed across loads (until a retry or revision revives the run).
    if (run && !isTerminal(run.status)) {
      killRun(run.projectId);
    } else if (run) {
      const ed = useEditor.getState();
      if (ed.projectId === run.projectId && ed.genvideo) {
        ed.setGenvideo({ ...ed.genvideo, cardDismissed: true });
      } else {
        void withProjectDoc(run.projectId, (doc) => {
          if (doc.genvideo) doc.genvideo = { ...doc.genvideo, cardDismissed: true };
        }).catch(() => {});
      }
    }
    set({ run: null });
  },
}));
