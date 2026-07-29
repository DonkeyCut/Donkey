"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { ArrowLeft, ArrowRight } from "lucide-react";

import { Button } from "@/components/ui/button";
import { AiChatSlide } from "@/cut/components/onboarding/slides/AiChat";
import { CreditsSlide } from "@/cut/components/onboarding/slides/Credits";
import { ModesSlide } from "@/cut/components/onboarding/slides/Modes";
import { ReferralSlide } from "@/cut/components/onboarding/slides/Referral";
import { WelcomeSlide } from "@/cut/components/onboarding/slides/Welcome";
import { onOpenOnboarding } from "@/cut/lib/onboarding";
import { track } from "@/lib/analytics";
import type { OnboardingRun, ReferralSource } from "@/lib/onboarding/sequence";
import { cn } from "@/lib/utils";
import {
  needsOnboarding,
  useOnboardingState,
  useSaveOnboarding,
} from "@/queries/onboarding";

const SLIDE_COUNT = 5;

// The welcome sequence: five slides over the whole window, shown once to a new
// account and again whenever settings asks to replay it. Mounted in the Cut app
// shell, above the connect gate, so a first run is the first thing an account
// sees and the gate is waiting underneath when it ends.
//
// The sequence reads state, it doesn't create it. Credits were granted at
// signup (src/lib/onboarding/signup-grants.ts) and the backend is picked by the
// connect gate; nothing here grants, switches, or configures anything. The one
// thing it writes is what it asks for: where the account heard about us.
export function CutOnboarding() {
  const { data: state } = useOnboardingState();
  const save = useSaveOnboarding();
  const [run, setRun] = useState<OnboardingRun | null>(null);
  const [step, setStep] = useState(0);
  const [referral, setReferral] = useState<ReferralSource | null>(null);
  // A first run opens once per page load, and only for an account that hasn't
  // finished this sequence.
  const autoOpened = useRef(false);
  const answerTimer = useRef<number | null>(null);

  const clearAnswerTimer = () => {
    if (answerTimer.current !== null) window.clearTimeout(answerTimer.current);
    answerTimer.current = null;
  };
  useEffect(() => clearAnswerTimer, []);

  const start = useCallback((source: OnboardingRun) => {
    setRun(source);
    setStep(0);
    setReferral(null);
    track("onboarding_started", { source });
  }, []);

  useEffect(() => {
    if (autoOpened.current || !needsOnboarding(state)) return;
    autoOpened.current = true;
    start("first_run");
  }, [state, start]);

  useEffect(() => onOpenOnboarding(() => start("replay")), [start]);

  const finish = useCallback(
    (skipped: boolean) => {
      if (!run) return;
      clearAnswerTimer();
      track("onboarding_completed", { source: run, skipped, step });
      save.mutate({ completed: true, skipped });
      setRun(null);
    },
    [run, save, step],
  );

  const back = useCallback(() => setStep((s) => Math.max(0, s - 1)), []);
  // Past the last slide is the end of the sequence, so one call covers both the
  // Next button and Get started.
  const advance = useCallback(() => {
    if (step >= SLIDE_COUNT - 1) finish(false);
    else setStep(step + 1);
  }, [step, finish]);

  useEffect(() => {
    if (!run) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") return finish(true);
      if (event.key === "ArrowLeft") return back();
      if (event.key === "ArrowRight" || event.key === "Enter") return advance();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [run, back, advance, finish]);

  if (!run) return null;

  // The answer saves on the click; the sequence moves on a beat later, so the
  // row gets to show it landed rather than vanishing under the next slide.
  // Tied to the click, not to the slide, so coming back to change an answer
  // doesn't bounce forward again.
  const selectReferral = (source: ReferralSource) => {
    setReferral(source);
    track("onboarding_referral_selected", { referralSource: source });
    save.mutate({ referralSource: source });
    clearAnswerTimer();
    answerTimer.current = window.setTimeout(advance, 220);
  };

  const last = step === SLIDE_COUNT - 1;

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label="Welcome to Donkey Cut"
      className="fixed inset-0 z-[80] flex flex-col bg-cream font-system text-ink antialiased"
    >
      <div className="flex shrink-0 items-center justify-between px-6 py-5 md:px-10">
        <span className="text-[15px] font-semibold tracking-[-0.01em]">Donkey Cut</span>
        <button
          type="button"
          onClick={() => finish(true)}
          className="rounded-full px-3 py-1.5 text-[14px] text-[#454545] transition-colors hover:bg-ink/5"
        >
          Skip
        </button>
      </div>

      {/* Auto margins rather than items-center: a slide taller than the window
          scrolls from its top instead of having it clipped away. */}
      <div className="flex min-h-0 flex-1 overflow-y-auto px-6 py-4 md:px-10">
        <div className="m-auto w-full max-w-[1100px]">
          {step === 0 && <WelcomeSlide />}
          {step === 1 && (
            <ReferralSlide selected={referral} onSelect={selectReferral} />
          )}
          {step === 2 && <ModesSlide />}
          {step === 3 && <CreditsSlide run={run} />}
          {step === 4 && <AiChatSlide />}
        </div>
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
          {Array.from({ length: SLIDE_COUNT }, (_, i) => (
            <span
              key={i}
              className={cn(
                "size-1.5 rounded-full transition-colors",
                i === step ? "bg-coral" : "bg-ink/20",
              )}
            />
          ))}
        </div>

        <Button
          onClick={advance}
          className="gap-1.5 rounded-full bg-ink px-5 text-white hover:bg-ink/90"
        >
          {last ? "Get started" : "Next"}
          {!last && <ArrowRight className="size-4" />}
        </Button>
      </div>
    </div>
  );
}
