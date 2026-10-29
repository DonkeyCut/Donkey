"use client";

// The starter tour: once the slides lift, the account works through a few real
// controls in its starter project, each one highlighted until it is used. The
// editor's own state says when a step is done, so a step moves on only when the
// person did the thing. driver.js draws the highlight and the popover, and its
// code loads only while a tour runs. The tour has no close: the starter holds
// the account (its back button is held) until the last step is done. An
// account that leaves another way finds New project locked, and the lock
// brings it back here.

import "driver.js/dist/driver.css";
import "./tour.css";

import type { Driver } from "driver.js";
import { useTranslations } from "next-intl";
import { useEffect, useRef } from "react";

import { useEngineUser } from "@/cut/lib/backend/hooks";
import {
  fillChatComposer,
  holdTour,
  releaseTour,
  useOnboardingCover,
  useTourSignals,
} from "@/cut/lib/onboarding";
import { requestSidePanel } from "@/cut/lib/panelRequest";
import { playheadAt } from "@/cut/lib/playhead";
import { starterProjectId } from "@/cut/lib/starter";
import { useEditor } from "@/cut/lib/store";
import { track } from "@/lib/analytics";
import { TOUR_STEPS, type TourStep } from "@/lib/onboarding/sequence";
import { nextTourStep, onboardingStage } from "@/lib/onboarding/stage";
import { useOnboardingState, useSaveOnboarding } from "@/queries/onboarding";

// How long a step waits for its control to show (the timeline mounting, a panel
// opening) before letting the step go, so a starter that lost that control can
// never hold the account in the tour.
const TARGET_WAIT_MS = 4_000;

// Panels slide in over 300 ms; the highlight lands once they settle.
const SETTLE_MS = 350;

// After a step the highlight clears and the tour waits this long before the
// next one, so the person sees what their action did: playback running, the
// clip's settings open, the Media tab showing.
const LINGER_MS = 1_500;

// What a control can scroll inside: the timeline and the app's scroll areas.
// A control scrolled out of one has left the highlight behind.
const SCROLLERS = "[data-tl-scroll], [data-slot='scroll-area-viewport']";

// How much of a control has to show each way to count as in view: nearly all
// of a small one, and this many px of a large one.
const IN_VIEW_SHARE = 0.9;
const IN_VIEW_PX = 80;

// The clip step lets playback run on to the next clip and pauses there. It
// picks one starting at least this far ahead, and stops waiting at the cap.
const APPROACH_LEAD_S = 0.5;
const APPROACH_CAP_MS = 10_000;

// The chat step types its example message at this pace, per character.
const TYPE_MS = 35;

// The chat step waits for the assistant's reply to land. A turn that hasn't
// started by the first bound never will; the second caps a long one.
const REPLY_START_MS = 5_000;
const REPLY_CAP_MS = 90_000;

type StepSpec = {
  find: () => Element | null;
  side: "top" | "right" | "bottom" | "left";
  // Puts the editor where the step can be done, and clears a state that would
  // read as done before the person acts.
  prepare: () => void;
  done: () => boolean;
  // How long the tour waits after the step, while its effect shows.
  linger: () => Promise<void>;
  // What runs before the step first shows, such as playback reaching the
  // control.
  approach?: (signal: AbortSignal) => Promise<void>;
  // A message the step types into its control once it shows.
  type?: "chat.prompt";
};

// Each step's popover body; a step whose title says it all has none.
const BODY = {
  play: null,
  clip: "clip.body",
  media: "media.body",
  chat: "chat.body",
} as const satisfies Record<TourStep, string | null>;

const STEPS: Record<TourStep, StepSpec> = {
  play: {
    find: () => shown('[data-tour="play"]:not(:disabled)'),
    side: "top",
    prepare: () => {
      const editor = useEditor.getState();
      editor.setTimelineOpen(true);
      editor.setPlaying(false);
    },
    done: () => useEditor.getState().playing,
    linger: () => pause(LINGER_MS),
  },
  clip: {
    find: () => aimedClip() ?? clipInView(),
    side: "top",
    prepare: () => {
      const editor = useEditor.getState();
      editor.setTimelineOpen(true);
      // Playback scrolls the timeline under the highlight, carrying the clip
      // away from it.
      editor.setPlaying(false);
      editor.select(null);
      // The step promises the clip's settings: a folded inspector would show
      // only its rail.
      editor.setInspectorOpen(true);
    },
    done: () => useEditor.getState().selection?.kind === "clip",
    linger: () => pause(LINGER_MS),
    approach: (signal) => playToNextClip(signal),
  },
  media: {
    find: () => shown('[data-tour="side-media"]'),
    side: "right",
    prepare: () => {
      if (useTourSignals.getState().sideTab === "media") {
        requestSidePanel(null);
      }
    },
    done: () => useTourSignals.getState().sideTab === "media",
    linger: () => pause(LINGER_MS),
  },
  chat: {
    find: () => shown('[data-tour="chat"]'),
    side: "left",
    prepare: () => {
      useTourSignals.setState({ chatSent: false });
      useEditor.getState().setAiOpen(true);
    },
    done: () => useTourSignals.getState().chatSent,
    type: "chat.prompt",
    linger: async () => {
      await replyLanded();
      await pause(LINGER_MS);
    },
  },
};

export function StarterTour({ projectId }: { projectId: string }) {
  const t = useTranslations("onboarding.tour");
  const userId = useEngineUser();
  const { data: state } = useOnboardingState();
  const { mutate: saveOnboarding } = useSaveOnboarding();
  const covered = useOnboardingCover((s) => s.up);
  const held = useTourSignals((s) => s.hold !== null);
  const loaded = useEditor((s) => s.loaded);

  // The step on screen: the account's next one, on its own starter project,
  // once the editor is loaded and the slides are gone.
  const onStarter = userId !== null && projectId === starterProjectId(userId);
  const step = onStarter && state && onboardingStage(state) === "tour" ? nextTourStep(state) : null;
  const active = step !== null && loaded && !covered && !held;

  // One driver for the run, so the highlight glides from step to step.
  const tour = useRef<Driver | null>(null);

  // The driver goes with the tour, and with the editor.
  useEffect(() => {
    if (active) {
      return;
    }
    tour.current?.destroy();
    tour.current = null;
  }, [active]);
  useEffect(
    () => () => {
      tour.current?.destroy();
      tour.current = null;
      useTourSignals.setState({ hold: null });
    },
    [],
  );

  // Each step: set the editor up, wait for the control, highlight it, and
  // record the step once the editor says it happened.
  useEffect(() => {
    if (!active || !step) {
      return;
    }
    const spec = STEPS[step];
    const abort = new AbortController();
    let unwatch = () => {};
    let untrack = () => {};
    let recorded = false;
    let typed = false;

    // The step is recorded at once, so leaving mid-pause keeps it. The
    // highlight clears so the editor shows the action's effect, and the pause
    // holds the next step, and the plans after the last, until it has.
    const complete = () => {
      if (recorded) {
        return;
      }
      recorded = true;
      unwatch();
      untrack();
      tour.current?.destroy();
      tour.current = null;
      track("onboarding_tour_step", { step });
      const token = holdTour();
      saveOnboarding({ tourStep: step });
      void spec.linger().then(() => releaseTour(token));
    };

    // Sets the editor up, waits for the control, and highlights it. Runs
    // again whenever the control leaves the highlight: scrolled away, its
    // panel closed, or re-rendered.
    const show = async () => {
      if (abort.signal.aborted || recorded) {
        return;
      }
      spec.prepare();
      const [{ driver }, found] = await Promise.all([
        import("driver.js"),
        waitForTarget(spec.find, TARGET_WAIT_MS, abort.signal),
      ]);
      if (abort.signal.aborted || recorded) {
        return;
      }

      // A control this starter doesn't have lets the step go.
      if (!found) {
        return complete();
      }
      await pause(SETTLE_MS);
      if (abort.signal.aborted || recorded) {
        return;
      }
      const target = spec.find();
      if (!target) {
        return complete();
      }

      tour.current ??= driver({
        allowClose: false,
        allowKeyboardControl: false,
        overlayClickBehavior: "none",
        overlayOpacity: 0.55,
        stagePadding: 6,
        stageRadius: 10,
        popoverClass: "donkey-tour",
      });
      tour.current.highlight({
        element: target,
        popover: {
          title: t(`${step}.title`),
          description: BODY[step] ? t(BODY[step]) : undefined,
          side: spec.side,
          align: "center",
          showButtons: [],
          showProgress: true,
          progressText: t("progress", { current: TOUR_STEPS.indexOf(step) + 1, total: TOUR_STEPS.length }),
        },
      });
      if (spec.type && !typed) {
        typed = true;
        void typeOut(t(spec.type), abort.signal);
      }
      untrack();
      untrack = followTarget(target, {
        moved: () => tour.current?.refresh(),
        lost: () => {
          untrack();
          void show();
        },
      });
    };

    // Doing the thing counts from the start, even before the highlight lands.
    unwatch = watchDone(spec.done, complete);
    void (spec.approach?.(abort.signal) ?? Promise.resolve()).then(show);

    return () => {
      abort.abort();
      unwatch();
      untrack();
    };
  }, [active, step, saveOnboarding, t]);

  return null;
}

// The first match in view: a route left behind by instant navigation stays
// mounted with display:none, and its controls must not count.
function shown(selector: string): Element | null {
  for (const el of document.querySelectorAll(selector)) {
    if (inView(el)) {
      return el;
    }
  }
  return null;
}

// Whether the control shows inside its scroller and the window, by enough to
// see and click it each way.
function inView(el: Element, axes: "both" | "vertical" = "both"): boolean {
  if (!el.isConnected || !el.checkVisibility()) {
    return false;
  }
  const rect = el.getBoundingClientRect();
  const frames = [new DOMRect(0, 0, window.innerWidth, window.innerHeight)];
  const scroller = el.closest(SCROLLERS);
  if (scroller) {
    frames.push(scroller.getBoundingClientRect());
  }
  const enough = (shown: number, size: number) => shown >= Math.min(size * IN_VIEW_SHARE, IN_VIEW_PX);
  return frames.every(
    (frame) =>
      enough(Math.min(rect.bottom, frame.bottom) - Math.max(rect.top, frame.top), rect.height) &&
      (axes === "vertical" ||
        enough(Math.min(rect.right, frame.right) - Math.max(rect.left, frame.left), rect.width)),
  );
}

// A clip's box on the timeline, by its id. An editor left behind by instant
// navigation keeps its own hidden copy, so the visible one is picked.
function clipBox(id: string): Element | null {
  const boxes = document.querySelectorAll(`[data-tl-scroll] [data-tl-sel="clip:${id}"]`);
  return [...boxes].find((el) => el.checkVisibility()) ?? null;
}

// The clip playback is running on to, picked by playToNextClip.
let aimedClipId: string | null = null;

// The aimed clip's box on the timeline, when it is in view.
function aimedClip(): Element | null {
  if (!aimedClipId) {
    return null;
  }
  const el = clipBox(aimedClipId);
  return el && inView(el) ? el : null;
}

// Lets running playback reach the next clip and pause at its start, where the
// timeline has brought it into view. Anything the person does in the meantime
// (a click, a key, a scroll) ends the wait at once, as does the cap. Resolves
// right away when nothing is playing or no clip lies ahead.
function playToNextClip(signal: AbortSignal): Promise<void> {
  aimedClipId = null;
  const editor = useEditor.getState();
  if (!editor.playing) {
    return Promise.resolve();
  }
  // A clip on a row in view, since the timeline follows the playhead
  // sideways, never up or down; failing that, the main row's next clip.
  const now = playheadAt();
  const ahead = editor.clips
    .filter((clip) => clip.start >= now + APPROACH_LEAD_S)
    .sort((a, b) => a.start - b.start);
  const next =
    ahead.find((clip) => {
      const el = clipBox(clip.id);
      return el !== null && inView(el, "vertical");
    }) ?? ahead.find((clip) => clip.track === 0);
  if (!next) {
    return Promise.resolve();
  }
  aimedClipId = next.id;
  useEditor.setState({ previewStopAt: next.start });

  return new Promise((resolve) => {
    const off = useEditor.subscribe((s) => {
      if (!s.playing) {
        finish();
      }
    });
    const timer = window.setTimeout(finish, APPROACH_CAP_MS);
    const listen = { capture: true, passive: true } as const;
    window.addEventListener("pointerdown", finish, listen);
    window.addEventListener("keydown", finish, listen);
    window.addEventListener("wheel", finish, listen);
    signal.addEventListener("abort", finish);
    function finish() {
      off();
      window.clearTimeout(timer);
      window.removeEventListener("pointerdown", finish, listen);
      window.removeEventListener("keydown", finish, listen);
      window.removeEventListener("wheel", finish, listen);
      signal.removeEventListener("abort", finish);
      resolve();
    }
  });
}

// Types `text` into the chat composer a character at a time. A key the person
// presses takes the composer back from it.
async function typeOut(text: string, signal: AbortSignal): Promise<void> {
  let stopped = false;
  const stop = () => {
    stopped = true;
  };
  window.addEventListener("keydown", stop, { capture: true });
  signal.addEventListener("abort", stop);
  for (let i = 1; i <= text.length && !stopped; i += 1) {
    fillChatComposer(text.slice(0, i));
    await pause(TYPE_MS);
  }
  window.removeEventListener("keydown", stop, { capture: true });
  signal.removeEventListener("abort", stop);
}

// The timeline clip in view nearest the playhead. With every clip scrolled
// away, the first one scrolls into view.
function clipInView(): Element | null {
  const clips = [...document.querySelectorAll('[data-tl-scroll] [data-tl-sel^="clip:"]')].filter((el) =>
    el.checkVisibility(),
  );
  const now = playheadAt();
  const starts = new Map(useEditor.getState().clips.map((clip) => [`clip:${clip.id}`, clip.start]));
  const away = (el: Element) => Math.abs((starts.get(el.getAttribute("data-tl-sel") ?? "") ?? Infinity) - now);
  const seen = clips.filter((el) => inView(el)).sort((a, b) => away(a) - away(b))[0];
  if (seen || !clips[0]) {
    return seen ?? null;
  }
  clips[0].scrollIntoView({ block: "nearest", inline: "nearest" });
  return clips[0];
}

// Keeps the highlight on its control: a scroll, a resize or a re-render
// checks once per frame whether the control is still in view. `moved` redraws
// the highlight where it is now; `lost` fires when it has gone.
function followTarget(target: Element, on: { moved: () => void; lost: () => void }): () => void {
  let frame = 0;
  const check = () => {
    frame = 0;
    if (inView(target)) {
      on.moved();
      return;
    }
    on.lost();
  };
  const schedule = () => {
    frame ||= window.requestAnimationFrame(check);
  };
  const resized = new ResizeObserver(schedule);
  resized.observe(target);
  const rendered = new MutationObserver(schedule);
  rendered.observe(document.body, { childList: true, subtree: true });
  document.addEventListener("scroll", schedule, { capture: true, passive: true });
  window.addEventListener("resize", schedule);
  return () => {
    window.cancelAnimationFrame(frame);
    resized.disconnect();
    rendered.disconnect();
    document.removeEventListener("scroll", schedule, { capture: true });
    window.removeEventListener("resize", schedule);
  };
}

// Resolves with the control once it shows, or null after `ms`.
function waitForTarget(find: () => Element | null, ms: number, signal: AbortSignal): Promise<Element | null> {
  return new Promise((resolve) => {
    const hit = find();
    if (hit) {
      return resolve(hit);
    }
    const observer = new MutationObserver(() => {
      const el = find();
      if (el) {
        finish(el);
      }
    });
    const timer = window.setTimeout(() => finish(null), ms);
    const finish = (el: Element | null) => {
      observer.disconnect();
      window.clearTimeout(timer);
      signal.removeEventListener("abort", stop);
      resolve(el);
    };
    const stop = () => finish(null);
    signal.addEventListener("abort", stop);
    observer.observe(document.body, { attributes: true, childList: true, subtree: true });
  });
}

const pause = (ms: number) => new Promise<void>((resolve) => window.setTimeout(resolve, ms));

// Resolves once a chat turn has started and finished, or when none starts in
// time, or at the cap.
function replyLanded(): Promise<void> {
  return new Promise((resolve) => {
    let started = useTourSignals.getState().chatRunning;
    const timers = [
      window.setTimeout(() => !started && finish(), REPLY_START_MS),
      window.setTimeout(finish, REPLY_CAP_MS),
    ];
    const off = useTourSignals.subscribe((s) => {
      if (s.chatRunning) {
        started = true;
        return;
      }
      if (started) {
        finish();
      }
    });
    function finish() {
      timers.forEach((timer) => window.clearTimeout(timer));
      off();
      resolve();
    }
  });
}

// Calls `onDone` once `done` holds, checking now and on every editor or tour
// signal change.
function watchDone(done: () => boolean, onDone: () => void): () => void {
  const check = () => {
    if (done()) {
      onDone();
    }
  };
  const offs = [useEditor.subscribe(check), useTourSignals.subscribe(check)];
  check();
  return () => offs.forEach((off) => off());
}
