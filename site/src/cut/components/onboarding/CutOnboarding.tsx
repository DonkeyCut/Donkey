"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ArrowLeft, ArrowRight } from "lucide-react";

import { Button } from "@/components/ui/button";
import { AiChatSlide } from "@/cut/components/onboarding/slides/AiChat";
import { CreditsSlide } from "@/cut/components/onboarding/slides/Credits";
import { ModesSlide } from "@/cut/components/onboarding/slides/Modes";
import { PlansSlide } from "@/cut/components/onboarding/slides/Plans";
import { ReferralSlide } from "@/cut/components/onboarding/slides/Referral";
import { WelcomeSlide } from "@/cut/components/onboarding/slides/Welcome";
import { useEngineUser } from "@/cut/lib/backend/hooks";
import { useCutBase } from "@/cut/lib/nav";
import { onOpenOnboarding, setOnboardingCover } from "@/cut/lib/onboarding";
import { track } from "@/lib/analytics";
import {
  ONBOARDING_VERSION,
  isKnownReferralSource,
  type OnboardingRun,
  type ReferralSource,
} from "@/lib/onboarding/sequence";
import { cn } from "@/lib/utils";
import { useProSubscription } from "@/queries/billing";
import {
  needsOnboarding,
  useOnboardingState,
  useSaveOnboarding,
} from "@/queries/onboarding";

const SLIDES = ["welcome", "referral", "modes", "credits", "ai-chat", "plans"] as const;

// One string for "what the question's answer is right now", so the seeded
// answer, the last write, and the current picks compare cheaply.
const referralSignature = (sources: ReferralSource[], other: string) =>
  `${[...sources].sort().join(",")}|${other}`;

// The sequence version this browser last saw this account finish. It exists so
// a returning load paints the app immediately instead of covering it while the
// account read is in flight; the account row stays the source of truth, and a
// browser with no record for this account waits the one request out. Keyed per
// account so one account finishing doesn't paint the app home over another
// account's owed first run.
const doneKey = (userId: string) => `cut-onboarding-done:${userId}`;

const doneHere = (userId: string): boolean =>
  typeof window !== "undefined" &&
  Number(localStorage.getItem(doneKey(userId)) ?? 0) >= ONBOARDING_VERSION;

// The welcome sequence: slides over the whole window, shown once to a new
// account and again whenever settings asks to replay it. Mounted in the Cut app
// shell, above the connect gate, so a first run is the first thing an account
// sees and the gate is waiting underneath when it ends. A first run is also the
// first thing it sees: the surface stays covered until the account read says
// whether the sequence is owed, rather than painting the app and taking it back.
//
// The sequence reads state, it doesn't create it. Credits were granted at
// signup (src/lib/onboarding/signup-grants.ts) and the backend is picked by the
// connect gate; nothing here grants, switches, or configures anything. The one
// thing it writes is what it asks for: where the account heard about us.
export function CutOnboarding() {
  const base = useCutBase();
  // Mounted inside a SessionGate, so the account is already bound. Read from
  // the binding rather than the session object, which answers null while the
  // auth client re-reads it and would key this browser's "seen it" mark to
  // no account at all.
  const userId = useEngineUser() ?? "";
  const { data: state, isPending } = useOnboardingState();
  const { data: pro } = useProSubscription();
  const save = useSaveOnboarding();
  const [rawStep, setStep] = useState(0);
  const saved = useMemo(() => (state?.referralSources ?? []).filter(isKnownReferralSource), [state]);
  const savedOther = saved.includes("other") ? (state?.referralOther ?? "") : "";
  const [referralDraft, setReferrals] = useState<ReferralSource[] | null>(null);
  const [otherDraft, setReferralOther] = useState<string | null>(null);
  const referrals = referralDraft ?? saved;
  const referralOther = otherDraft ?? savedOther;
  const [dismissed, setDismissed] = useState(false);
  const [replaying, setReplaying] = useState(false);
  // Read once per mount: whether this browser can skip the wait below.
  const [skipWait] = useState(() => doneHere(userId));
  // Arriving at the sequence's own address is an explicit ask — a signup lands
  // there — so the sequence is the first paint, ahead of the account read.
  const [askedByAddress] = useState(
    () =>
      typeof window !== "undefined" &&
      window.location.pathname === `${base}/onboarding`,
  );
  // What the account already has, so leaving the question without changing
  // anything writes nothing.
  const savedReferrals = useRef<string | null>(null);

  // Which run is on screen, derived rather than set: the account read landing
  // is what opens a first run, and nothing has to push that into state. On the
  // sequence's address the run opens before that read answers; it is a first
  // run until the read says the account already finished, which makes it the
  // replay that account linked back to.
  const run: OnboardingRun | null = replaying
    ? "replay"
    : dismissed
      ? null
      : needsOnboarding(state)
        ? "first_run"
        : askedByAddress
          ? isPending
            ? "first_run"
            : "replay"
          : null;

  // Navigation and progress use the slides this account can see.
  const isPro = pro?.isActive ?? false;
  const signupCredits = state?.signupCredits ?? null;
  const slides = useMemo(
    () => SLIDES.filter((slide) =>
      (slide !== "credits" || signupCredits !== null) &&
      (slide !== "plans" || !isPro)),
    [signupCredits, isPro],
  );
  const slideCount = slides.length;
  const step = Math.min(rawStep, slideCount - 1);
  const slide = slides[step];

  // Once per open. On the sequence's address the run label can settle from
  // first_run to replay when the account read lands; that is the same open.
  const started = useRef(false);
  useEffect(() => {
    if (!run) {
      started.current = false;
      return;
    }
    if (started.current) return;
    started.current = true;
    track("onboarding_started", { source: run });
  }, [run]);

  // The editor underneath reads this to hold the starter project's first
  // playback until the slides hand over.
  useEffect(() => {
    setOnboardingCover(run !== null);
  }, [run]);

  // While the sequence is up, the address says so — it can be linked, reloaded,
  // and read off the bar wherever it was opened from. This rewrites the address
  // rather than navigating: the page underneath is already the right one, and
  // routing away would tear down the overlay showing over it. Closing puts back
  // the address the user arrived with.
  useEffect(() => {
    if (!run) return;
    const target = `${base}/onboarding`;
    const here = window.location.pathname + window.location.search;
    const back = here.startsWith(target) ? base : here;
    if (here !== target) window.history.replaceState(null, "", target);
    return () => {
      if (window.location.pathname === target) {
        window.history.replaceState(null, "", back);
      }
    };
  }, [run, base]);

  // An account that's already done teaches this browser to stop waiting.
  useEffect(() => {
    if (!state || needsOnboarding(state)) return;
    localStorage.setItem(doneKey(userId), String(state.version));
  }, [state, userId]);

  useEffect(
    () =>
      onOpenOnboarding(() => {
        setStep(0);
        setReplaying(true);
      }),
    [],
  );

  // The answers go up when the sequence leaves the question, so picking several
  // is one write rather than one per tap. Every way out passes through here.
  const commitReferrals = useCallback(() => {
    const other = referrals.includes("other") ? referralOther.trim() : "";
    const signature = referralSignature(referrals, other);
    if (!referrals.length || signature === (savedReferrals.current ?? referralSignature(saved, savedOther))) return;
    savedReferrals.current = signature;
    track("onboarding_referral_selected", {
      referralSources: referrals,
      ...(other && { referralOther: other }),
    });
    save.mutate({ referralSources: referrals, ...(other && { referralOther: other }) });
  }, [referrals, referralOther, saved, savedOther, save]);

  const finish = useCallback(
    (skipped: boolean) => {
      if (!run) return;
      commitReferrals();
      track("onboarding_completed", { source: run, skipped, step });
      save.mutate({ completed: true, skipped });
      localStorage.setItem(doneKey(userId), String(ONBOARDING_VERSION));
      setReplaying(false);
      setDismissed(true);
    },
    [commitReferrals, run, save, step, userId],
  );

  const back = useCallback(() => {
    commitReferrals();
    setStep(Math.max(0, step - 1));
  }, [commitReferrals, step]);
  const advance = useCallback(() => {
    // The question holds the sequence until it has an answer. Guarded here as
    // well as on the button, or the arrow keys would walk right past it.
    if (slide === "referral" && !referrals.length) return;
    commitReferrals();
    if (step >= slideCount - 1) {
      // The plans slide ends the sequence through its own two answers — Get
      // Pro, or continue with free. Arrowing or Entering past it would be a
      // third, silent one, so forward stops there. A subscriber never sees that
      // slide, so forward off their last one is how the sequence ends.
      if (isPro) finish(false);
      return;
    }
    setStep(step + 1);
  }, [commitReferrals, finish, isPro, referrals, slide, slideCount, step]);

  useEffect(() => {
    if (!run) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") return finish(true);
      if (event.key === "ArrowLeft") return back();
      if (event.key === "ArrowRight") return advance();
      if (event.key !== "Enter") return;
      // Enter on a focused control belongs to that control: the browser is
      // about to dispatch its click. Advancing here as well would run both —
      // picking a referral source and leaving the slide in the same keystroke,
      // which is what made the multi-select unusable from the keyboard, and
      // turning Enter on Back into a step forward and back that nets nothing.
      const target = event.target as HTMLElement | null;
      if (target?.closest("button, a, input, select, textarea, [role='button']")) return;
      advance();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [run, back, advance, finish]);

  // The landing nav's lockup, same icon box and wordmark size. Shared by the
  // hold below and the open sequence, so one becoming the other repaints
  // nothing.
  const lockup = (
    <span className="flex items-center gap-0">
      <span className="flex size-[59px] shrink-0 items-center justify-center overflow-hidden rounded-[10px]">
        <img
          src="/donkey-logo.svg"
          alt=""
          width={59}
          height={59}
          className="block h-full w-full object-contain"
        />
      </span>
      <span className="text-2xl font-semibold">Donkey Cut</span>
    </span>
  );

  // Between the session landing and the account read answering, an account that
  // turns out to need the sequence would otherwise watch the app paint and then
  // be covered. Hold the surface for that one request — only for a browser with
  // no record of this account finishing, so it isn't a wait everyone pays on
  // every load. The hold is the sequence's own first frame, so an account that
  // needs it watches the slide arrive rather than a repaint; one that turns out
  // to be done pays a single cream frame here once, then the record above
  // skips the hold for good.
  if (!run) {
    const waiting = isPending && !skipWait;
    return waiting ? (
      <div className="fixed inset-0 z-[80] flex flex-col bg-cream font-system text-ink antialiased">
        <div className="flex shrink-0 items-center justify-between px-6 py-2 md:px-10 md:py-2.5">
          {lockup}
        </div>
      </div>
    ) : null;
  }

  const toggleReferral = (source: ReferralSource) => {
    setReferrals((draft) => {
      const current = draft ?? saved;
      return current.includes(source)
        ? current.filter((s) => s !== source)
        : [...current, source];
    });
  };

  const last = step === slideCount - 1;
  // A subscriber's last slide ends the sequence from the footer, where everyone
  // else finds the plans slide's own two answers.
  const done = last && isPro;

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label="Welcome to Donkey Cut"
      className="fixed inset-0 z-[80] flex flex-col bg-cream font-system text-ink antialiased"
    >
      <div className="flex shrink-0 items-center justify-between px-6 py-2 md:px-10 md:py-2.5">
        {lockup}

        {/* A subscriber is being told about what they already pay for, so they
            get the door: the same way out Escape takes. Everyone else meets it
            at the end, where the plans slide asks its question. */}
        {isPro ? (
          <Button
            variant="ghost"
            onClick={() => finish(true)}
            className="text-[#454545]"
          >
            Skip
          </Button>
        ) : null}
      </div>

      {/* Slides sit high rather than centered: the spacers split the free space
          one part above to three below. They collapse first, so a slide taller
          than the window scrolls from its top instead of being clipped. */}
      <div className="flex min-h-0 flex-1 flex-col overflow-x-hidden overflow-y-auto px-6 py-4 md:px-10">
        <div aria-hidden className="min-h-4 flex-[1]" />
        <div className="mx-auto w-full max-w-[1100px]">
          {slide === "welcome" && <WelcomeSlide />}
          {slide === "referral" && (
            <ReferralSlide
              selected={referrals}
              onToggle={toggleReferral}
              otherText={referralOther}
              onOtherTextChange={setReferralOther}
            />
          )}
          {slide === "modes" && <ModesSlide />}
          {slide === "credits" && signupCredits !== null && (
            <CreditsSlide
              credits={signupCredits}
              expiresAt={state?.signupCreditsExpiresAt ?? null}
            />
          )}
          {slide === "ai-chat" && <AiChatSlide />}
          {slide === "plans" && <PlansSlide onSkipPro={() => finish(false)} />}
        </div>
        <div aria-hidden className="flex-[3]" />
      </div>

      <div className="flex shrink-0 items-center justify-between gap-4 px-6 py-5 md:px-10">
        <Button
          variant="ghost"
          onClick={back}
          className={cn("gap-1.5 text-[#454545]", step === 0 && "invisible")}
        >
          <ArrowLeft className="size-4" /> Back
        </Button>

        <div className="flex items-center gap-1.5">
          {Array.from({ length: slideCount }, (_, i) => (
            <span
              key={i}
              className={cn(
                "size-1.5 rounded-full transition-colors",
                i === step ? "bg-coral" : "bg-ink/20",
              )}
            />
          ))}
        </div>

        {/* The plans slide carries its own two ways out — Get Pro, or continue
            with free — so the footer keeps only the space there, not a third
            button. A subscriber ends on the slide before it, and Done is what
            takes them out. */}
        <Button
          onClick={advance}
          disabled={slide === "referral" && !referrals.length}
          className={cn(
            "gap-1.5 rounded-full bg-ink px-5 text-white hover:bg-ink/90",
            last && !done && "invisible",
          )}
        >
          {done ? (
            "Done"
          ) : (
            <>
              Next
              <ArrowRight className="size-4" />
            </>
          )}
        </Button>
      </div>
    </div>
  );
}
