"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import { Clapperboard, Laptop, Loader2, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  apiFetch,
  bindCutMode,
  hasLocalCompute,
  releaseCutMode,
  subscribeCutMode,
} from "@/cut/lib/backend";
import { knownDocVersion } from "@/cut/lib/backend/cloud";
import { loadedDocVersion } from "@/cut/lib/backend/shared";
import { flushCachedDocWrites, writeCachedDoc, writeCachedDocDirty } from "@/cut/lib/docCache";
import {
  refreshShareCard,
  refreshShareLadder,
  renderPreviewProxy,
  type ExportDoc,
} from "@/cut/lib/exportClient";
import { fileZoneAt, hasRefDrag, selectionRefTokens } from "@/cut/lib/assetRef";
import { startUpload } from "@/cut/lib/importQueue";
import { enrichAsset, importFileToProject, prepareImport } from "@/cut/lib/media";
import { clearCopiedFrame, copiedFrameFile, hasCopiedFrame } from "@/cut/lib/stageFrame";
// Side-effect import: registers the brief-to-video resume subscription, so a
// persisted run resumes on project load even when the AI panel never mounts.
import "@/cut/lib/genScene";
// Side-effect import: registers the bundled Google font families (build-time
// self-hosted) into the shared font registry before any text renders.
import "@/cut/lib/googleFonts";
import { syncFontAssets } from "@/cut/lib/fontAssets";
import { syncLinkedLibrary } from "@/cut/lib/linkedLibrary";
import { reportActivity } from "@/cut/lib/tabActivity";
import { TabStatus } from "./TabStatus";
import { installDevHooks } from "@/cut/lib/devHooks";
import { meterPerf, stopMeter } from "@/cut/lib/perfTrace";
import { track } from "@/lib/analytics";
import { ensureCloudThreads } from "@/cut/lib/chatCloud";
import { readProjectThreads, writeActiveChat } from "@/cut/lib/chatThreads";
import { backTarget, useCutBase } from "@/cut/lib/nav";
import { useOnboardingCover } from "@/cut/lib/onboarding";
import { requestSidePanel } from "@/cut/lib/panelRequest";
import { reportSwallowed } from "@/cut/lib/report";
import { resolveProjectPlacement } from "@/cut/lib/residency";
import {
  docAudioClips,
  docClips,
  docOverlays,
  projectDuration,
  serializeDoc,
  storedAssets,
  useEditor,
} from "@/cut/lib/store";
import { playheadAt, previewAt, skimAt } from "@/cut/lib/playhead";
import type { MediaAsset } from "@/cut/lib/types";
import { AiPanel } from "./AiPanel";
import { ExportDialog } from "./ExportDialog";
import { Inspector } from "./Inspector";
import { Lightbox } from "./Lightbox";
import { Preview } from "./Preview";
import { SidePanel } from "./SidePanel";
import { Timeline } from "./Timeline";
import { StorageUpgradeDialog } from "./StorageUpgradeDialog";
import { TopBar } from "./TopBar";
import { ViewerTopBar } from "./ViewerTopBar";

/** Bounds on the viewer's change poll. The server picks the interval inside
 * this range from how long the owner has been idle; the floor keeps a live
 * edit feeling live, the ceiling keeps a hidden tab or a settled project from
 * polling forever. */
const VIEWER_POLL_MIN_MS = 5_000;
const VIEWER_POLL_MAX_MS = 300_000;

/** Floor between hover-proxy rebuilds. The proxy is a full render of the whole
 * cut, so a session spent flipping between tabs must not spend the render pool
 * on it. */
const PROXY_MIN_GAP_MS = 60_000;

export function Editor({
  projectId,
  from,
  folder,
  viewer = false,
}: {
  projectId: string;
  from?: string | null;
  folder?: string | null;
  /** Read-only share view: the share page bound the shared backend and put
   * the store in read-only mode before mounting. */
  viewer?: boolean;
}) {
  useEffect(() => installDevHooks(), []);
  // Preview diagnostics, for accounts that turned them on in settings: the
  // engine counts what its frames did and sends a summary every half minute of
  // playback. Off — and costing a null check — for everyone else.
  useEffect(() => {
    let live = true;
    void fetch("/api/account/feature-flags")
      .then((r) => (r.ok ? (r.json() as Promise<{ flags: { id: string; enabled: boolean }[] }>) : null))
      .then((body) => {
        if (!live || !body) return;
        const on = body.flags.some((f) => f.id === "preview_diagnostics" && f.enabled);
        if (on) meterPerf((sample) => track("cut_preview_perf", sample));
      })
      .catch(() => {});
    return () => {
      live = false;
      stopMeter();
    };
  }, []);
  const back = backTarget(useCutBase(), from, folder);
  const loaded = useEditor((s) => s.loaded);
  const loadError = useEditor((s) => s.loadError);
  // The tab is the open project, so it wears the project's name — through
  // renames too. Leaving hands the title back to whatever it was.
  const projectName = useEditor((s) => s.projectName);
  useEffect(() => {
    if (!projectName) return;
    const previous = document.title;
    document.title = projectName;
    return () => {
      document.title = previous;
    };
  }, [projectName]);
  // Until loadProject runs, the store still holds the previously open project;
  // rendering the editor against it would leak that project's state (chat,
  // clips, selection) into this route.
  const stale = useEditor((s) => s.projectId) !== projectId;
  // Leaving the editor keeps the store as it was, so on reopening the same
  // project `stale` alone would let a full editor — preview, decoders, poster
  // — render against that leftover state for the frames before the load
  // resets it: a flash of the old picture, then the loading screen. The
  // editor earns its first paint only once this mount's own load has begun.
  const [opened, setOpened] = useState(false);
  const exportOpen = useEditor((s) => s.exportOpen);
  const aiOpen = useEditor((s) => s.aiOpen);
  const sharedFeatures = useEditor((s) => s.sharedFeatures);
  // The inspector only earns its column when the selection has a panel to
  // show; otherwise (nothing selected, a subtitle cue, a transition bar — the
  // Transitions tab is its panel) it is an empty white panel, so collapse it
  // and let the preview take the space.
  const hasInspector = useEditor((s) => {
    if (s.readOnly || s.selection == null) return false;
    if (s.selection.kind === "cue" || s.selection.kind === "transition") return false;
    if (s.multiSelection.length <= 1) return true;
    // A multi-selection (marquee, ⌘-click) has no single item to edit, so the
    // panel stays closed. The exception is a grouped element: selecting it
    // selects its whole group, and the panel edits the clicked member.
    const first = s.multiSelection[0];
    if (first?.kind !== "overlay") return false;
    const gid = s.overlays.find((o) => o.id === first.id)?.groupId;
    if (!gid) return false;
    return s.multiSelection.every(
      (m) => m?.kind === "overlay" && s.overlays.find((o) => o.id === m.id)?.groupId === gid
    );
  });
  const [importing, setImporting] = useState(0);
  // Files being probed and named, plus the ones already placed whose bytes are
  // still going out — both are work the save indicator reports.
  const sending = useEditor((s) =>
    s.assets.reduce((n, a) => (a.upload && !a.upload.error ? n + 1 : n), 0)
  );
  // Bytes moving into the project are work the tab should show.
  useEffect(() => {
    reportActivity("import", importing + sending > 0);
  }, [importing, sending]);

  // Uploaded fonts become live FontFaces the moment their assets exist (and
  // drop out when deleted), so titles set in them never measure a fallback.
  const assetsForFonts = useEditor((s) => s.assets);
  useEffect(() => void syncFontAssets(assetsForFonts), [assetsForFonts]);
  // What the Library lends rather than copies — the account's own typefaces
  // today — is in reach whichever project is open.
  useEffect(() => void syncLinkedLibrary(), []);
  const [conflictReloaded, setConflictReloaded] = useState(false);
  const [shareGone, setShareGone] = useState(false);
  // This project lives on this Mac and the Donkey app isn't answering. Nothing
  // to load, and nothing to guess at either: say where it is and wait.
  const [needsApp, setNeedsApp] = useState(false);
  const dragDepth = useRef(0);

  // Load the project document, then enrich assets (thumbs/waveforms) lazily.
  // Residency is a fact about the project, not the link: resolve where the id
  // lives (residency.ts) and pin the backend before anything else fetches.
  // Pinning, rather than setting the ambient mode, is what makes this stick —
  // the ConnectGate's engine probe finishes on its own schedule and would
  // otherwise flip an open cloud project onto the engine. It is also what
  // raises the gate's banner over a local project the app isn't answering for:
  // the banner follows the open project's residency.
  // A share view skips that — its page pinned the shared backend already.
  useEffect(() => {
    let alive = true;
    let waiting: (() => void) | undefined;

    const open = () => {
      const bind = viewer
        ? Promise.resolve({ mode: "shared" as const, reachable: true })
        : resolveProjectPlacement(projectId).then((placement) => {
            if (alive) bindCutMode(placement.mode);
            return placement;
          });
      void bind.then((placement) => {
        if (!alive) return;
        if (placement.reachable) {
          setNeedsApp(false);
          // loadProject clears `loaded` synchronously before its first await,
          // so marking the mount opened here can never show the editor
          // against leftover state.
          const load = useEditor.getState().loadProject(projectId);
          setOpened(true);
          void load.then(() => {
            for (const asset of useEditor.getState().assets) void enrichAsset(asset);
          });
          return;
        }
        // The project is on this Mac with no app answering. The gate keeps
        // probing behind its banner, so wait for that rather than retrying:
        // the moment the app is back, this opens the project as if the user
        // had just clicked it. Waiting on the engine here — rather than
        // re-running on it — is what keeps an open cloud project from being
        // re-resolved out from under its own pinned backend.
        waiting = subscribeCutMode(() => {
          if (!alive || !hasLocalCompute()) return;
          waiting?.();
          waiting = undefined;
          open();
        });
        // The gate's probe may have reached the engine while the placement
        // above was resolving — its announcement fired before this
        // subscription existed. Subscribing first and then reading the
        // current answer closes that gap in both orders.
        if (hasLocalCompute()) {
          waiting();
          waiting = undefined;
          open();
          return;
        }
        setNeedsApp(true);
      });
    };
    open();

    // An export still rendering after a reload rejoins on its own: the app-wide
    // exports dock polls the engine's job feed, so it reappears with no per-
    // project reconnect here.
    return () => {
      alive = false;
      waiting?.();
      releaseCutMode();
    };
  }, [projectId, viewer]);

  // A doc that carries `firstOpen` presents itself on its first open in this
  // browser: the editor reads the block and follows it — which side-panel tab
  // shows (null folds the panel to its rail), whether chat opens on the
  // newest saved thread, whether playback starts. Playback is held while the
  // welcome slides still cover the editor, so it starts the moment they hand
  // over. Applied once per browser; after this the layout is the user's own
  // to keep. The seeded starter template is what ships the block today.
  useEffect(() => {
    if (!loaded || viewer) return;
    const intro = useEditor.getState().firstOpen;
    if (!intro) return;
    const seenKey = `cut-first-open-${projectId}`;
    if (localStorage.getItem(seenKey)) return;
    localStorage.setItem(seenKey, "1");
    let alive = true;
    const cleanups: (() => void)[] = [];
    if (intro.sidePanel !== undefined) requestSidePanel(intro.sidePanel);
    if (intro.chat === true) {
      // No thread named: the panel opens on a fresh empty chat.
      useEditor.getState().setAiOpen(true);
    } else if (intro.chat) {
      // Point the chat at the named thread before the panel mounts, so it
      // opens the seeded conversation rather than a blank one.
      const wantedId = intro.chat;
      void ensureCloudThreads(projectId).then(() => {
        if (!alive) return;
        const threads = readProjectThreads(projectId);
        const wanted = threads.find((t) => t.id === wantedId) ?? threads[0];
        if (wanted) writeActiveChat(projectId, wanted.id);
        useEditor.getState().setAiOpen(true);
      });
    }
    if (intro.play) {
      if (!useOnboardingCover.getState().up) {
        useEditor.getState().setPlaying(true);
      } else {
        const unsub = useOnboardingCover.subscribe((s) => {
          if (s.up) return;
          unsub();
          useEditor.getState().setPlaying(true);
        });
        cleanups.push(unsub);
      }
    }
    return () => {
      alive = false;
      cleanups.forEach((fn) => fn());
    };
  }, [loaded, viewer, projectId]);

  // Delayed follow of the owner's edits: poll the doc version and reload on
  // change, keeping the playhead. A 401/403/404 means the share was revoked or
  // narrowed — stop and say so.
  //
  // The server sets the pace (x-cut-poll-after), because it knows how long the
  // owner has been idle: an actively edited project answers in seconds, a
  // settled one stretches to minutes so a shared link that a crowd is watching
  // costs a handful of requests instead of six per viewer per minute. The
  // response is cached at the edge for that same interval, so the poll usually
  // never reaches the origin at all.
  useEffect(() => {
    if (!viewer) return;
    let stopped = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const tick = async () => {
      if (stopped) return;
      let nextIn = document.hidden ? VIEWER_POLL_MAX_MS : VIEWER_POLL_MIN_MS;
      try {
        if (!document.hidden) {
          const res = await apiFetch(`/api/cut/projects/${projectId}`, { method: "HEAD" });
          if ([401, 403, 404].includes(res.status)) {
            stopped = true;
            setShareGone(true);
            return;
          }
          if (res.ok) {
            const after = Number(res.headers.get("x-cut-poll-after"));
            if (Number.isFinite(after) && after > 0) {
              nextIn = Math.min(VIEWER_POLL_MAX_MS, Math.max(VIEWER_POLL_MIN_MS, after * 1000));
            }
            // Compare against the version the loaded doc reported, so a doc
            // still coming from cache is fetched again on the next tick
            // instead of the viewer settling on an older cut.
            const version = res.headers.get("x-cut-doc-version");
            const showing = loadedDocVersion(projectId);
            if (version && showing && version !== showing) {
              const at = playheadAt();
              await useEditor.getState().loadProject(projectId, { inPlace: true });
              for (const asset of useEditor.getState().assets) void enrichAsset(asset);
              useEditor.getState().seek(at);
            }
          }
        }
      } catch {
        // Transient network failure — the next tick retries.
      } finally {
        if (!stopped) timer = setTimeout(() => void tick(), nextIn);
      }
    };
    timer = setTimeout(() => void tick(), VIEWER_POLL_MIN_MS);
    return () => {
      stopped = true;
      if (timer) clearTimeout(timer);
    };
  }, [viewer, projectId]);

  // A cloud save hit a newer stored version (another session's edits won).
  // Take the newer doc through the ordinary load path — the GET returns it and
  // rebinds the driver's version — and say so.
  useEffect(() => {
    if (viewer) return;
    const onConflict = (e: Event) => {
      const detail = (e as CustomEvent<{ projectId: string }>).detail;
      if (!detail || detail.projectId !== projectId) return;
      void useEditor
        .getState()
        .loadProject(projectId, { inPlace: true })
        .then(() => {
          for (const asset of useEditor.getState().assets) void enrichAsset(asset);
        });
      setConflictReloaded(true);
    };
    window.addEventListener("cut-cloud-doc-conflict", onConflict);
    return () => window.removeEventListener("cut-cloud-doc-conflict", onConflict);
  }, [projectId, viewer]);

  // Keep the project card's hover proxy — and a shared project's link-preview
  // card — following the cut. Both are full renders of the whole project on the
  // same worker pool the exports run on, so they wait for a lull instead of
  // firing while the user is still working: every change stashes the cut as it
  // stands, and it renders when the editor closes or the tab goes to the
  // background. Rebuilding on each settle instead meant a session of editing
  // spent most of the pool on artwork nobody was waiting for, with the user's
  // own export queued behind it.
  useEffect(() => {
    if (viewer) return;
    let pending: ExportDoc | null = null;
    let rendering = false;
    let lastRun = 0;
    // The stashed doc renders as captured, so a flush that lands after the
    // store has moved on still writes this project's proxy rather than nothing.
    // `final` marks a one-shot exit (the project closing, the page going away):
    // there is no next chance, so it skips the rate floor rather than leaving
    // the card frozen mid-edit.
    const flush = async (final = false) => {
      const doc = pending;
      if (!doc || rendering || (!final && Date.now() - lastRun < PROXY_MIN_GAP_MS)) return;
      pending = null;
      rendering = true;
      lastRun = Date.now();
      try {
        await renderPreviewProxy(projectId, doc);
        refreshShareCard(projectId);
        // The share's streaming ladder rides this same lull. It is the most
        // expensive of the three — the whole cut, once per rung — so it runs
        // last, and it no-ops for a project that isn't shared.
        await refreshShareLadder(projectId);
      } finally {
        rendering = false;
      }
    };
    // Backgrounding the tab is the reliable signal that the user has stepped
    // away — it fires on a tab switch, a window blur, and on the way out of the
    // page, where an unmount alone never runs.
    const onVisibility = () => {
      if (document.visibilityState === "hidden") void flush();
    };
    const onPageHide = () => void flush(true);
    document.addEventListener("visibilitychange", onVisibility);
    window.addEventListener("pagehide", onPageHide);
    let last: {
      clips: unknown;
      audioClips: unknown;
      overlays: unknown;
      subtitles: unknown;
      aspect: string;
      fadeIn: number;
      fadeOut: number;
      background: string;
    } | null = null;
    const unsub = useEditor.subscribe((s) => {
      if (!s.loaded || s.projectId !== projectId) return;
      const changed =
        last !== null &&
        (s.clips !== last.clips ||
          s.audioClips !== last.audioClips ||
          s.overlays !== last.overlays ||
          s.subtitles !== last.subtitles ||
          s.aspect !== last.aspect ||
          s.fadeIn !== last.fadeIn ||
          s.fadeOut !== last.fadeOut ||
          s.background !== last.background);
      last = {
        clips: s.clips,
        audioClips: s.audioClips,
        overlays: s.overlays,
        subtitles: s.subtitles,
        aspect: s.aspect,
        fadeIn: s.fadeIn,
        fadeOut: s.fadeOut,
        background: s.background,
      };
      if (!changed) return; // first tick just primes the baseline
      // A cut of titles and shapes over the background has a picture to show;
      // only an empty project has nothing to render a card from.
      if (projectDuration(s) <= 0) return;
      pending = {
        aspect: s.aspect,
        assets: s.assets,
        clips: s.clips,
        audioClips: s.audioClips,
        overlays: s.overlays,
        subtitles: s.subtitles,
        fadeIn: s.fadeIn,
        fadeOut: s.fadeOut,
        background: s.background,
      };
    });
    return () => {
      unsub();
      document.removeEventListener("visibilitychange", onVisibility);
      window.removeEventListener("pagehide", onPageHide);
      void flush(true); // the project is closing: land whatever is still stashed
    };
  }, [projectId, viewer]);

  // Autosave: debounce document changes into PUT /api/cut/projects/<id>.
  useEffect(() => {
    if (viewer) return;
    let timer: ReturnType<typeof setTimeout> | null = null;
    let last = serializeDoc(useEditor.getState());
    let lastName = useEditor.getState().projectName;
    // serializeDoc copies the bars, so the store's array is the baseline: a
    // parked bar changes no clip field, and comparing the copies would never
    // see it.
    let lastBars = useEditor.getState().transitions;

    // Transient failures (the network coming back up after a laptop wake, a
    // 5xx) retry on a capped backoff so unsaved work never parks on a dead
    // link; 4xx (e.g. a version conflict, which has its own recovery event)
    // waits for the next edit as before.
    let failures = 0;
    const retry = () => {
      failures = Math.min(failures + 1, 5);
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => void save(), 2000 * 2 ** (failures - 1));
    };
    // One save on the wire at a time: an edit landing mid-save queues one
    // trailing save that captures the state as it stands then, instead of
    // racing a second PUT alongside the first — the engine would apply the
    // two in whichever order they arrive, and the cloud would answer the
    // second with a conflict against this same session's write.
    let inFlight = false;
    let queued = false;
    // Bumped on every edit. A save that succeeds only rewrites the disk
    // snapshot clean when no edit landed while it was on the wire — a newer
    // dirty record must not be overwritten by the older doc the save carried.
    let editSeq = 0;
    const save = async () => {
      if (inFlight) {
        queued = true;
        return;
      }
      inFlight = true;
      try {
        await putDoc();
      } finally {
        inFlight = false;
        if (queued) {
          queued = false;
          void save();
        }
      }
    };
    const putDoc = async () => {
      const s = useEditor.getState();
      if (!s.loaded || s.projectId !== projectId) return;
      s.setSaveState("saving");
      const doc = serializeDoc(s);
      const seqAtSend = editSeq;
      try {
        const res = await apiFetch(`/api/cut/projects/${projectId}`, {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(doc),
        });
        if (res.ok) {
          failures = 0;
          useEditor.getState().setSaveState("saved");
          // The snapshot the next open paints from is whatever this browser
          // last put on the server, so it tracks every save.
          if (editSeq === seqAtSend) writeCachedDoc(projectId, doc);
          return;
        }
        useEditor.getState().setSaveState("error");
        if (res.status >= 500) retry();
      } catch {
        useEditor.getState().setSaveState("error");
        retry();
      }
    };

    // Re-baselined every time a document is hydrated — the snapshot an open
    // paints, the live document that replaces it, a conflict reload — so a
    // document that came from the server is never saved straight back to it.
    let primedEpoch = -1;
    // Assets change identity on runtime enrichment (thumbs, peaks) too, so a
    // new reference compares by its stored projection: field edits like an
    // origin change ("Add to Media", chat tagging) must save, enrichment not.
    let lastAssetsRef = useEditor.getState().assets;
    let lastAssetsJson = JSON.stringify(storedAssets(lastAssetsRef));
    const assetsChanged = (assets: MediaAsset[]): boolean => {
      if (assets === lastAssetsRef) return false;
      const json = JSON.stringify(storedAssets(assets));
      const changed = json !== lastAssetsJson;
      lastAssetsRef = assets;
      lastAssetsJson = json;
      return changed;
    };
    const unsub = useEditor.subscribe((s) => {
      if (!s.loaded || s.projectId !== projectId) return;
      if (s.loadEpoch !== primedEpoch) {
        // First tick after a hydration: snapshot the freshly loaded doc so
        // arriving at one never counts as an edit.
        primedEpoch = s.loadEpoch;
        last = serializeDoc(s);
        lastName = s.projectName;
        lastBars = s.transitions;
        assetsChanged(s.assets);
        return;
      }
      // The open resumed unsaved edits from the dirty disk snapshot: the
      // document on screen is already ahead of the server, so push it up
      // without waiting for a fresh edit.
      if (s.resumePush) {
        useEditor.setState({ resumePush: false });
        if (timer) clearTimeout(timer);
        timer = setTimeout(() => void save(), 800);
        return;
      }
      // Evaluated every tick (not short-circuited) so the asset baseline
      // advances even when another slice triggered this save.
      const assetsDirty = assetsChanged(s.assets);
      const changed =
        assetsDirty ||
        // The projections, not the raw arrays: clips waiting on an upload are
        // held out of the document, and holding one is not an edit.
        docClips(s.clips, s.assets) !== (last.clips as unknown) ||
        docAudioClips(s.audioClips, s.assets) !== (last.audioClips as unknown) ||
        docOverlays(s.overlays) !== (last.overlays as unknown) ||
        s.transitions !== lastBars ||
        s.templates !== (last.templates as unknown) ||
        s.subtitles !== (last.subtitles as unknown) ||
        s.aspect !== last.aspect ||
        s.fadeIn !== (last.fadeIn ?? 0) ||
        s.fadeOut !== (last.fadeOut ?? 0) ||
        s.publish.caption !== last.publish?.caption ||
        s.publish.tags !== last.publish?.tags ||
        s.publish.soundTitle !== last.publish?.soundTitle ||
        s.publish.handle !== last.publish?.handle ||
        s.notes.text !== last.notes?.text ||
        s.notes.publishedAt !== last.notes?.publishedAt ||
        s.notes.links.join("") !== (last.notes?.links ?? []).join("") ||
        // Normalized like serializeDoc stores it (?? null): a project with no
        // run holds undefined in state and null in the doc — not a change.
        (s.genvideo ?? null) !== ((last.genvideo ?? null) as unknown) ||
        s.renders !== (last.renders as unknown) ||
        s.projectName !== lastName;
      if (!changed) return;
      last = serializeDoc(s);
      lastName = s.projectName;
      lastBars = s.transitions;
      editSeq++;
      // Every edit lands on disk marked dirty before it lands on the server,
      // with the version it was edited on top of: a crash or a closed tab
      // inside the debounce window resumes on the next open instead of
      // losing the edit.
      writeCachedDocDirty(projectId, last, knownDocVersion(projectId));
      if (s.saveState !== "saving") s.setSaveState("dirty");
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => void save(), 800);
    });
    // Coalesced dirty writes land now or not at all when the page goes away.
    const onPageHide = () => flushCachedDocWrites();
    window.addEventListener("pagehide", onPageHide);
    return () => {
      unsub();
      if (timer) clearTimeout(timer);
      window.removeEventListener("pagehide", onPageHide);
      flushCachedDocWrites();
    };
  }, [projectId, viewer]);

  const importFiles = useCallback(
    async (
      files: FileList | File[],
      opts?: {
        at?: number;
        origin?: MediaAsset["origin"];
        mediaOnly?: boolean;
        /** Display name for the asset, when the file's own name is a storage
         * detail (a copied frame). */
        name?: string;
        /** Land at `at` itself on the first row with room, opening a new row
         * when every one of them is busy there — what a paste means by "here".
         * Without it the file takes track 0's next free slot. */
        atFirstFit?: boolean;
      }
    ) => {
      const list = Array.from(files);
      setImporting((n) => n + list.length);
      // Files are prepared one at a time: each claims its stored name against
      // the names already taken, so two drops of the same name must not race
      // for it. Only the bytes go out in parallel, from the upload queue.
      for (const file of list) {
        try {
          // Cloud: the file is probed and named before anything is uploaded,
          // so it can be placed now and sent behind the editor. Local: the
          // engine names a file only once it holds the bytes.
          const pending = await prepareImport(projectId, file);
          const asset = pending?.asset ?? (await importFileToProject(projectId, file));
          if (!asset) continue;
          // Recordings are created media: tag them so they land on the timeline
          // but never in the Media panel (reserved for user imports).
          if (opts?.origin) asset.origin = opts.origin;
          if (opts?.name) asset.name = opts.name;
          const s = useEditor.getState();
          // Probing, naming and (for a pasted frame) rendering all outlive a
          // project switch. The asset was prepared against `projectId` and its
          // bytes live in that project's storage, so filing it into whatever
          // document is open now would point the new project at the old one's
          // media.
          if (s.projectId !== projectId) continue;
          s.addAsset(asset);
          // mediaOnly stocks the Media panel and leaves the timeline alone
          // (drops that land outside the timeline); placement is up to the user.
          if (!opts?.mediaOnly) {
            if (opts?.atFirstFit) {
              s.addAssetAtPlayhead(asset.id, opts.at);
            } else if (asset.type === "video" || asset.type === "image") {
              // A drop on the timeline lands at the pointer (sliding to track
              // 0's next free slot); an upload appends at the end. A still
              // rides track 0 like footage.
              s.addClipFromAsset(asset.id, opts?.at);
            } else {
              // A timeline drop lands at the pointer; an upload drops at the
              // playhead (the store slides it right only if that spot is taken).
              s.addAudioFromAsset(asset.id, opts?.at);
            }
          }
          // A pending import already holds its bytes, so the filmstrip is
          // drawn from those rather than downloaded back from storage.
          void enrichAsset(asset, pending?.localUrl);
          if (pending) startUpload(projectId, pending);
        } catch (err) {
          reportSwallowed(`[cut] import failed for ${file.name}`, err);
        } finally {
          setImporting((n) => n - 1);
        }
      }
    },
    [projectId]
  );

  // Whole-window drag & drop for OS files. Chrome tags native <img> drags
  // with `Files` too, so internal drags — which always carry the ref MIME —
  // are filtered out; dragging a stock tile never lights the drop hints.
  useEffect(() => {
    if (viewer) return;
    const isFileDrag = (e: DragEvent) =>
      !!e.dataTransfer?.types.includes("Files") && !hasRefDrag(e);
    // "media" when the drag carries at least one video/audio/image (the
    // timeline is a valid target); text-only drags only concern the chat.
    // Items that hide their MIME type during the drag count as media.
    const dragKind = (e: DragEvent): "media" | "other" => {
      const items = Array.from(e.dataTransfer?.items ?? []).filter((i) => i.kind === "file");
      return items.length === 0 ||
        items.some((i) => !i.type || /^(video|audio|image)\//.test(i.type))
        ? "media"
        : "other";
    };
    // Time under the pointer when the drop lands on the timeline's tracks,
    // else null. Geometric, because the drop is handled at the window level
    // and the pointer may sit over any timeline child.
    const timelineDropTime = (e: DragEvent): number | null => {
      const scroll = document.querySelector(".tl-scroll");
      const inner = document.querySelector(".tl-content");
      if (!scroll || !inner) return null;
      const r = scroll.getBoundingClientRect();
      if (e.clientY < r.top || e.clientY > r.bottom || e.clientX < r.left || e.clientX > r.right)
        return null;
      const t = (e.clientX - inner.getBoundingClientRect().left) / useEditor.getState().pxPerSec;
      return Math.max(0, t);
    };
    // The video canvas joins the timeline as a place that adds to the cut: a
    // drop there appends, since the canvas has no time under the pointer.
    const overCanvas = (e: DragEvent) => {
      const pane = document.querySelector(".preview-pane");
      if (!pane) return false;
      const r = pane.getBoundingClientRect();
      return (
        e.clientX >= r.left && e.clientX <= r.right && e.clientY >= r.top && e.clientY <= r.bottom
      );
    };
    // The hint tracks where the files would land. Over a panel that takes them
    // itself — Media, Library, a composer — nothing global lights up; that zone
    // lights itself. The timeline lights only over the timeline or the canvas,
    // the two places a drop joins the cut; elsewhere the drag still hints the
    // chat as a target ("other").
    const hintKind = (e: DragEvent): "media" | "other" | null => {
      if (fileZoneAt(e.clientX, e.clientY)) return null;
      if (dragKind(e) !== "media") return "other";
      return timelineDropTime(e) != null || overCanvas(e) ? "media" : "other";
    };
    const setHint = (kind: "media" | "other" | null) => {
      if (useEditor.getState().dropActive !== kind) useEditor.getState().setDropActive(kind);
    };
    const enter = (e: DragEvent) => {
      if (!isFileDrag(e)) return;
      e.preventDefault();
      dragDepth.current++;
      setHint(hintKind(e));
    };
    // Crossing between panels mid-drag fires no `dragenter` on the window, so
    // the hint follows the pointer here.
    const over = (e: DragEvent) => {
      if (!isFileDrag(e)) return;
      e.preventDefault();
      setHint(hintKind(e));
    };
    const leave = (e: DragEvent) => {
      if (!isFileDrag(e)) return;
      dragDepth.current = Math.max(0, dragDepth.current - 1);
      if (dragDepth.current === 0) useEditor.getState().setDropActive(null);
    };
    const drop = (e: DragEvent) => {
      if (hasRefDrag(e) || !e.dataTransfer?.files.length) return;
      e.preventDefault();
      dragDepth.current = 0;
      useEditor.getState().setDropActive(null);
      // Files land where they were dropped: a file-taking panel (Media,
      // Library, a composer) keeps them; the timeline places at the pointer;
      // the canvas appends to the cut; anywhere else imports into the project
      // and leaves the timeline alone.
      const zone = fileZoneAt(e.clientX, e.clientY);
      if (zone) {
        zone(Array.from(e.dataTransfer.files));
        return;
      }
      const at = timelineDropTime(e);
      if (at != null) {
        // The first drop on an empty timeline starts the cut at 0: a lone
        // clip floating at the pointer time reads as broken.
        const s = useEditor.getState();
        const empty = s.clips.length === 0 && s.audioClips.length === 0;
        void importFiles(e.dataTransfer.files, { at: empty ? 0 : at });
        return;
      }
      void importFiles(e.dataTransfer.files, { mediaOnly: !overCanvas(e) });
    };
    window.addEventListener("dragenter", enter);
    window.addEventListener("dragover", over);
    window.addEventListener("dragleave", leave);
    window.addEventListener("drop", drop);
    return () => {
      window.removeEventListener("dragenter", enter);
      window.removeEventListener("dragover", over);
      window.removeEventListener("dragleave", leave);
      window.removeEventListener("drop", drop);
    };
  }, [importFiles, viewer]);

  // An image on the system clipboard joins the cut: a frame copied from
  // another tab's preview, a screenshot, a picture from anywhere else. The
  // editor's own ⌘V claims the timeline clipboard and the copied frame before
  // this — both stop the keystroke, so no paste event follows them — and a
  // composer marks its own paste handled, so this only ever sees the pastes
  // nobody else wanted. The picture lands under the indicator, on the first
  // row with room for it.
  useEffect(() => {
    if (viewer) return;
    const onPaste = (e: ClipboardEvent) => {
      const s = useEditor.getState();
      if (e.defaultPrevented || s.readOnly) return;
      // A dialog on top owns the paste, the same way it owns the shortcuts.
      if (s.exportOpen || document.querySelector('[data-slot="dialog-content"]')) return;
      const target = e.target as HTMLElement | null;
      const textEntry =
        !!target &&
        (target.tagName === "TEXTAREA" ||
          target.tagName === "INPUT" ||
          target.isContentEditable);
      if (textEntry) return;
      const files = Array.from(e.clipboardData?.items ?? [])
        .filter((i) => i.kind === "file" && i.type.startsWith("image/"))
        .map((i) => i.getAsFile())
        .filter((f): f is File => f !== null);
      if (files.length === 0) return;
      e.preventDefault();
      void importFiles(files, { at: Math.max(0, previewAt()), atFirstFit: true });
    };
    window.addEventListener("paste", onPaste);
    return () => window.removeEventListener("paste", onPaste);
  }, [importFiles, viewer]);

  // Keyboard shortcuts.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement;
      const inputType = (target as HTMLInputElement).type;
      const textEntry =
        target.tagName === "TEXTAREA" ||
        target.tagName === "SELECT" ||
        target.isContentEditable ||
        (target.tagName === "INPUT" &&
          !["checkbox", "radio", "range", "button"].includes(inputType));
      if (textEntry) return;
      // Let native toggle/slider behavior win for focused controls.
      const controlFocused =
        target.tagName === "INPUT" || target.closest('[role="switch"],[role="slider"]') !== null;
      const s = useEditor.getState();
      if (s.exportOpen || document.querySelector('[data-slot="dialog-content"]')) return;

      // A read-only view keeps playback keys; everything that edits is out.
      if (s.readOnly) {
        const allowed =
          e.code === "Space" ||
          e.key === "ArrowLeft" ||
          e.key === "ArrowRight" ||
          e.key === "Escape" ||
          ((e.metaKey || e.ctrlKey) &&
            e.key.toLowerCase() === "j" &&
            s.sharedFeatures?.chat === true);
        if (!allowed) return;
      }

      if (e.code === "Space" && !controlFocused) {
        e.preventDefault();
        if (!s.playing && playheadAt() >= projectDuration(s) - 0.01) s.seek(0);
        s.setPlaying(!s.playing);
      } else if (e.key === "Backspace" || e.key === "Delete") {
        e.preventDefault();
        s.deleteSelection();
      } else if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "z") {
        e.preventDefault();
        if (e.shiftKey) s.redo();
        else s.undo();
      } else if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "c") {
        // Selected page text keeps native ⌘C. Otherwise, alongside the
        // internal copy (for ⌘V back onto the timeline), the selection's
        // mention tokens go to the system clipboard, so a copied clip,
        // element, transition, cue, or keyframe pastes into the chat
        // composer as a reference.
        if (!window.getSelection()?.toString()) {
          const token = selectionRefTokens(s);
          if (token) void navigator.clipboard.writeText(token).catch(() => {});
          // The newer copy owns the clipboard: a copied preview frame steps
          // aside for this one.
          const copied = s.copySelection();
          if (copied) clearCopiedFrame();
          if (copied || token) e.preventDefault();
        }
      } else if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "v") {
        // The timeline clipboard first; a frame copied off the preview canvas
        // lands as a still under the indicator. Where it lands is read at the
        // keystroke, so a still that waits on its draw or its upload still
        // arrives where the paste was aimed.
        if (s.paste()) e.preventDefault();
        else if (hasCopiedFrame()) {
          e.preventDefault();
          const at = Math.max(0, previewAt());
          void copiedFrameFile()
            .then((grab) => {
              if (grab) {
                return importFiles([grab.file], {
                  at,
                  atFirstFit: true,
                  origin: "freeze",
                  name: grab.name,
                });
              }
            })
            .catch((err) => reportSwallowed("[cut] paste frame failed", err));
        }
      } else if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "g") {
        // ⌘G groups the multi-selected elements, ⇧⌘G dissolves the primary's
        // group — the panel's Group button is out of reach while a
        // multi-selection keeps the inspector closed.
        e.preventDefault();
        if (e.shiftKey) {
          const gid =
            s.selection?.kind === "overlay"
              ? s.overlays.find((o) => o.id === s.selection!.id)?.groupId
              : undefined;
          if (gid) s.ungroupOverlays(gid);
        } else {
          s.groupSelectedOverlays();
        }
      } else if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "j") {
        e.preventDefault();
        s.setAiOpen(!s.aiOpen);
      } else if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "b") {
        e.preventDefault();
        // Cut at the skimmer when the mouse is over the timeline.
        s.splitAtPlayhead(skimAt() ?? undefined);
      } else if (e.key.toLowerCase() === "s" && !e.metaKey && !e.ctrlKey) {
        s.splitAtPlayhead(skimAt() ?? undefined);
      } else if (e.key.toLowerCase() === "t" && !e.metaKey && !e.ctrlKey) {
        s.addOverlay();
      } else if ((e.key === "ArrowLeft" || e.key === "ArrowRight") && !controlFocused) {
        e.preventDefault();
        // While playing, arrows skip in 1s jumps and playback rolls on (seek
        // never pauses); paused, they step a frame — 1s with Shift — for
        // precise editing.
        const step = s.playing ? 1 : e.shiftKey ? 1 : 1 / 30;
        s.seek(playheadAt() + (e.key === "ArrowLeft" ? -step : step));
      } else if (e.key === "Escape") {
        s.select(null);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [importFiles]);

  // The project is here, on this Mac — it just can't be opened without the app
  // that holds it. The gate's banner sits above this with the recovery steps,
  // and the moment the app answers this screen loads the project itself.
  if (needsApp) {
    return (
      <div className="grid h-full place-items-center">
        <div className="flex max-w-sm flex-col items-center gap-3 text-center">
          <Laptop className="size-7 text-muted-foreground" />
          <p className="text-sm text-muted-foreground">
            This is a local project — it lives on this Mac. Open the Donkey app and it opens
            here.
          </p>
          <Button
            variant="outline"
            nativeButton={false}
            render={<Link href={back.href}>Back to {back.tab}</Link>}
          />
        </div>
      </div>
    );
  }

  if (loadError && !stale) {
    return (
      <div className="grid h-full place-items-center">
        <div className="flex flex-col items-center gap-3 text-center">
          <Clapperboard className="size-7 text-muted-foreground" />
          <p className="text-sm text-muted-foreground">{loadError}</p>
          <Button
            variant="outline"
            nativeButton={false}
            render={<Link href={back.href}>Back to {back.tab}</Link>}
          />
        </div>
      </div>
    );
  }

  if (!opened || !loaded || stale) {
    // The spinner waits a beat before showing: a snapshot open lands within a
    // few frames, and a spinner that blinks in and out for those frames reads
    // as flicker, not progress.
    return (
      <div className="grid h-full place-items-center text-muted-foreground">
        <div className="animate-in fade-in [animation-delay:300ms] [animation-fill-mode:backwards]">
          <Loader2 className="size-5 animate-spin" />
        </div>
      </div>
    );
  }

  const anySidePanel = sharedFeatures
    ? sharedFeatures.media || sharedFeatures.genai || sharedFeatures.subtitles || sharedFeatures.details
    : true;

  return (
    // The shell tracks the window rather than flooring at a width the window
    // has to scroll to reach. A floor moved the problem instead of solving it:
    // the editor kept its full size and the page scrolled sideways, so the
    // preview ran off the edge, the top bar measured a header wider than the
    // screen and never folded its buttons away, and the chat panel opened into
    // space that was not there. Shrinking, each of those resolves on its own —
    // the panels give up width, the top bar collapses to a menu, and the
    // timeline scrolls inside itself as it always has.
    <div className="flex h-full min-w-0 overflow-hidden">
      {/* The tab wears whatever is still running here. */}
      <TabStatus />
      <div className="grid min-w-0 flex-1 grid-rows-[46px_minmax(0,1fr)_auto]">
        {viewer ? (
          <ViewerTopBar />
        ) : (
          <TopBar
            onImport={importFiles}
            from={from}
            folder={folder}
            uploading={importing + sending}
          />
        )}
        <div
          className={`grid min-h-0 ${
            hasInspector ? "grid-cols-[auto_minmax(0,1fr)_272px]" : "grid-cols-[auto_minmax(0,1fr)]"
          }`}
        >
          {anySidePanel && (
            <SidePanel projectId={projectId} onImport={importFiles} importing={importing > 0} />
          )}
          {!anySidePanel && <div />}
          <div className="grid min-h-0 min-w-0">
            <Preview />
          </div>
          {hasInspector && <Inspector />}
        </div>
        <Timeline />
      </div>
      {aiOpen && (!viewer || sharedFeatures?.chat) && (
        <AiPanel
          key={projectId}
          projectId={projectId}
          onClose={() => useEditor.getState().setAiOpen(false)}
        />
      )}
      {exportOpen && <ExportDialog />}
      {shareGone && (
        <div className="fixed top-14 left-1/2 z-50 -translate-x-1/2 rounded-full bg-foreground/90 px-3.5 py-1.5 text-xs font-medium text-background shadow-lg">
          This share is no longer available.
        </div>
      )}
      {conflictReloaded && (
        <div className="fixed top-14 left-1/2 z-50 flex -translate-x-1/2 items-center gap-1.5 rounded-full bg-foreground/90 py-1.5 pr-1.5 pl-3.5 text-background shadow-lg">
          <span className="text-xs font-medium">Reloaded a newer version saved elsewhere.</span>
          <Button
            variant="ghost"
            size="icon-sm"
            aria-label="Dismiss"
            className="rounded-full text-background hover:bg-background/15 hover:text-background"
            onClick={() => setConflictReloaded(false)}
          >
            <X />
          </Button>
        </div>
      )}
      <StorageUpgradeDialog />
      <Lightbox />
    </div>
  );
}
