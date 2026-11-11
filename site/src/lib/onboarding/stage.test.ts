import { describe, expect, test } from "bun:test";

import { ONBOARDING_VERSION, TOUR_STEPS } from "@/lib/onboarding/sequence";
import { nextTourStep, onboardingStage, tourHoldsNew } from "@/lib/onboarding/stage";

const DONE_AT = "2026-10-29T00:00:00.000Z";
const REPLAYED_AT = "2026-11-11T00:00:00.000Z";

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

// A finished account that replayed the sequence keeps its finish; slides that
// ended after it open the tour again.
describe("replay", () => {
  const replay = { ...fresh, completedAt: DONE_AT, slidesDoneAt: REPLAYED_AT, tourSteps: ["play"] };

  test("tours the starter again", () => {
    expect(onboardingStage(replay)).toBe("tour");
  });

  test("is done once the replay finishes", () => {
    expect(onboardingStage({ ...replay, completedAt: "2026-11-12T00:00:00.000Z" })).toBe("done");
  });

  test("never holds new projects", () => {
    expect(tourHoldsNew(replay)).toBe(false);
    expect(tourHoldsNew({ ...fresh, slidesDoneAt: DONE_AT })).toBe(true);
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
