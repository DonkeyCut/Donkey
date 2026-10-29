import { describe, expect, test } from "bun:test";

import { ONBOARDING_VERSION, TOUR_STEPS } from "@/lib/onboarding/sequence";
import { nextTourStep, onboardingStage } from "@/lib/onboarding/stage";

const DONE_AT = "2026-10-29T00:00:00.000Z";

// A brand-new account: nothing done, starter seeded.
const fresh = {
  version: ONBOARDING_VERSION,
  completedAt: null,
  slidesDoneAt: null,
  tourSteps: [] as string[],
  starterReady: true,
};

describe("onboardingStage", () => {
  test("waits for the account read", () => {
    expect(onboardingStage(undefined)).toBeNull();
  });

  test("starts on the slides", () => {
    expect(onboardingStage(fresh)).toBe("slides");
  });

  test("tours the starter once the slides are done", () => {
    expect(onboardingStage({ ...fresh, slidesDoneAt: DONE_AT })).toBe("tour");
    expect(onboardingStage({ ...fresh, slidesDoneAt: DONE_AT, tourSteps: ["play", "clip"] })).toBe("tour");
  });

  test("shows the plans once every tour step is done", () => {
    expect(onboardingStage({ ...fresh, slidesDoneAt: DONE_AT, tourSteps: [...TOUR_STEPS] })).toBe("plans");
  });

  test("goes from the slides to the plans without a starter", () => {
    expect(onboardingStage({ ...fresh, slidesDoneAt: DONE_AT, starterReady: false })).toBe("plans");
  });

  // Every account that finished the old sequence has completedAt and none of
  // the new fields; it must never land back in the tour or the lock.
  test("leaves a finished account done", () => {
    expect(onboardingStage({ ...fresh, completedAt: DONE_AT })).toBe("done");
  });
});

describe("nextTourStep", () => {
  test("walks the steps in order and skips done ones", () => {
    expect(nextTourStep({ tourSteps: [] })).toBe("play");
    expect(nextTourStep({ tourSteps: ["play"] })).toBe("clip");
    expect(nextTourStep({ tourSteps: ["play", "media"] })).toBe("clip");
    expect(nextTourStep({ tourSteps: [...TOUR_STEPS] })).toBeNull();
  });
});
