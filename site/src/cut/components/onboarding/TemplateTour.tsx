"use client";

// The template tour: in a project made from a template, three highlights
// teach how to put the person's own footage in. Open a clip's ⋮ menu, see
// Replace in it, and see the assistant do it for every clip. Each step moves
// on when the person clicks the highlighted control, and none of them changes
// the project: the Replace click is caught before it opens anything, and the
// chat step only points at the composer. It runs by itself in the first two
// projects an account makes from templates; the ? on a template project's
// timeline runs it again until the project is changed or a run there ends. A
// run ends once, so opening the project again never repeats it. It looks and
// runs like the starter tour, on the same driver.js highlight.

import "driver.js/dist/driver.css";
import "./tour.css";

import type { Driver } from "driver.js";
import { useTranslations } from "next-intl";
import { CircleHelp } from "lucide-react";
import { useEffect, useRef, useState } from "react";

import { TimelineActionButton } from "@/cut/components/TimelineActionButton";
import { endTemplateTour, replayTemplateTour, useOnboardingCover, useTemplateTourCue } from "@/cut/lib/onboarding";
import { useEditor } from "@/cut/lib/store";
import { track } from "@/lib/analytics";
import { TEMPLATE_TOUR_RUNS, TEMPLATE_TOUR_STEPS, type TemplateTourStep } from "@/lib/onboarding/sequence";
import { onboardingStage } from "@/lib/onboarding/stage";
import { useOnboardingState, useSaveOnboarding } from "@/queries/onboarding";

import { followTarget, inView, pause, shown, waitForTarget } from "./tourDom";

// How long a step waits for its control to show before giving up on it, so a
// project without a clip menu never holds the tour.
const TARGET_WAIT_MS = 4_000;

// A closed menu takes back the Replace step: after this long without its
// item, the tour points at the ⋮ again.
const MENU_GONE_MS = 600;

// Panels and menus animate in; the highlight lands once they settle.
const SETTLE_MS = 250;

// What a click on the highlight does besides moving the run on: it reaches
// the control, or it stays a lesson and never does.
type StepClick = "pass" | "swallow";

type StepSpec = {
  find: () => Element | null;
  side: "top" | "right" | "bottom" | "left";
  prepare: () => void;
  click: StepClick;
};

const MENU_SELECTOR = '[data-tour="clip-menu"]';

const STEPS: Record<TemplateTourStep, StepSpec> = {
  "template-menu": {
    find: clipMenu,
    side: "top",
    prepare: () => {
      const editor = useEditor.getState();
      editor.setTimelineOpen(true);
      editor.setPlaying(false);
    },
    click: "pass",
  },
  "template-replace": {
    find: () => shown('[data-tour="clip-replace"]'),
    side: "right",
    prepare: () => {},
    click: "swallow",
  },
  "template-chat": {
    find: () => shown('[data-tour="chat"]'),
    side: "left",
    prepare: () => useEditor.getState().setAiOpen(true),
    click: "pass",
  },
};

// The popover's copy key for each step.
const COPY: Record<TemplateTourStep, "menu" | "replace" | "chat"> = {
  "template-menu": "menu",
  "template-replace": "replace",
  "template-chat": "chat",
};

export function TemplateTour({ projectId }: { projectId: string }) {
  const t = useTranslations("onboarding.templateTour");
  const tp = useTranslations("onboarding.tour");
  const { data: state } = useOnboardingState();
  const { mutate: saveOnboarding } = useSaveOnboarding();
  const cue = useTemplateTourCue((s) => s.projectId);
  const run = useTemplateTourCue((s) => s.run);
  const covered = useOnboardingCover((s) => s.up);
  const loaded = useEditor((s) => s.loaded);

  // The step on screen, once nothing else is teaching. A fresh copy starts
  // at the top while the account has finished fewer runs than the tour
  // takes; a run the ? asked for always does. Each click moves the run on.
  const seen = state?.tourSteps ?? [];
  const runsDone = TEMPLATE_TOUR_RUNS.filter((r) => seen.includes(r)).length;
  const key = `${projectId}:${run}`;
  const [at, setAt] = useState<{ key: string; index: number } | null>(null);
  const index = at?.key === key ? at.index : run > 0 || runsDone < TEMPLATE_TOUR_RUNS.length ? 0 : -1;
  const step = index >= 0 ? (TEMPLATE_TOUR_STEPS[index] ?? null) : null;
  const ready = cue === projectId && onboardingStage(state) === "done" && loaded && !covered;
  const active = ready && step !== null;

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
    },
    [],
  );

  useEffect(() => {
    if (!active || !step) {
      return;
    }
    const spec = STEPS[step];
    const abort = new AbortController();
    let untrack = () => {};
    let unclick = () => {};
    let done = false;

    // The click on the highlight moves the run on. The last one ends the run
    // and takes the project's ? away; a run the copy started also counts
    // toward the account's tours.
    const complete = () => {
      if (done) {
        return;
      }
      done = true;
      untrack();
      unclick();
      tour.current?.destroy();
      tour.current = null;
      track("onboarding_tour_step", { step });
      setAt({ key, index: index + 1 });
      if (index + 1 < TEMPLATE_TOUR_STEPS.length) {
        return;
      }
      const finished = TEMPLATE_TOUR_RUNS[runsDone];
      if (run === 0 && finished) {
        saveOnboarding({ tourStep: finished });
      }
      endTemplateTour();
      useEditor.setState({ fromTemplate: null });
    };

    const show = async () => {
      if (abort.signal.aborted || done) {
        return;
      }
      spec.prepare();
      const [{ driver }, found] = await Promise.all([
        import("driver.js"),
        waitForTarget(spec.find, step === "template-replace" ? MENU_GONE_MS : TARGET_WAIT_MS, abort.signal),
      ]);
      if (abort.signal.aborted || done) {
        return;
      }

      // The menu closed under the Replace step: point at the ⋮ again.
      if (!found && step === "template-replace") {
        setAt({ key, index: 0 });
        return;
      }

      // A project without the control ends the run where it is, and its ?
      // stays to run it again.
      if (!found) {
        endTemplateTour();
        return;
      }
      await pause(SETTLE_MS);
      const target = spec.find();
      if (abort.signal.aborted || done || !target) {
        return;
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
          title: t(`${COPY[step]}.title`),
          description: t(`${COPY[step]}.body`),
          side: spec.side,
          align: "center",
          showButtons: [],
          showProgress: true,
          progressText: tp("progress", {
            current: TEMPLATE_TOUR_STEPS.indexOf(step) + 1,
            total: TEMPLATE_TOUR_STEPS.length,
          }),
        },
      });
      unclick();
      unclick = onPress(target, spec.click, complete);
      untrack();
      untrack = followTarget(target, {
        moved: () => tour.current?.refresh(),
        lost: () => {
          untrack();
          void show();
        },
      });
    };

    void show();

    return () => {
      abort.abort();
      untrack();
      unclick();
      unmark();
    };
  }, [active, step, index, key, run, runsDone, saveOnboarding, t, tp]);

  return null;
}

/** The ? at the left of a template project's timeline toolbar: it runs the
 * tour again from the top. */
export function TemplateTourButton() {
  const t = useTranslations("onboarding.templateTour");
  const projectId = useEditor((s) => s.projectId);
  return (
    <TimelineActionButton
      label={t("replay")}
      tooltip={t("replay")}
      onClick={() => projectId && replayTemplateTour(projectId)}
    >
      <CircleHelp />
    </TimelineActionButton>
  );
}

// The ⋮ in view nearest the timeline's left edge. The button shows only on
// hover, so the tour marks it to stay shown.
function clipMenu(): Element | null {
  const menus = [...document.querySelectorAll(`[data-tl-scroll] ${MENU_SELECTOR}`)]
    .filter((el) => el.closest('[data-tl-sel^="clip:"]') !== null && inView(el))
    .sort((a, b) => a.getBoundingClientRect().left - b.getBoundingClientRect().left);
  const menu = menus[0] ?? null;
  menu?.setAttribute("data-tour-shown", "");
  return menu;
}

// Calls `onPress` when the person presses the highlighted control. A
// swallowed press never reaches it: the control's menu closes and nothing it
// would open opens.
function onPress(target: Element, click: StepClick, onPress: () => void): () => void {
  const swallow = click === "swallow";
  const press = (e: Event) => {
    if (!(e.target instanceof Node) || !target.contains(e.target)) {
      return;
    }
    if (swallow) {
      e.preventDefault();
      e.stopPropagation();
    }
    if (e.type !== "click") {
      return;
    }
    if (swallow) {
      target.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    }
    onPress();
  };
  const types = ["pointerdown", "pointerup", "click"] as const;
  types.forEach((type) => window.addEventListener(type, press, { capture: true }));
  return () => {
    types.forEach((type) => window.removeEventListener(type, press, { capture: true }));
    unmark();
  };
}

// Lets the ⋮ the tour kept shown go back to showing on hover.
function unmark() {
  document.querySelectorAll("[data-tour-shown]").forEach((el) => el.removeAttribute("data-tour-shown"));
}
