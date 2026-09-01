import { afterEach, describe, expect, test } from "bun:test";
import { isPosthogQueryConfigured, PosthogConfigError } from "./posthog";

const KEY = "POSTHOG_PERSONAL_API_KEY";
const ID = "POSTHOG_PROJECT_ID";
const saved = { key: process.env[KEY], id: process.env[ID] };

const set = (name: string, value: string | undefined) => {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
};

const raisesConfigError = (run: () => unknown): boolean => {
  try {
    run();
  } catch (e) {
    return e instanceof PosthogConfigError;
  }
  return false;
};

afterEach(() => {
  set(KEY, saved.key);
  set(ID, saved.id);
});

describe("PostHog query configuration", () => {
  test("both present reads as configured", () => {
    set(KEY, "phx_test");
    set(ID, "110583");
    expect(isPosthogQueryConfigured()).toBe(true);
  });

  test("either one missing skips PostHog", () => {
    set(KEY, "phx_test");
    set(ID, undefined);
    expect(isPosthogQueryConfigured()).toBe(false);
    set(KEY, undefined);
    set(ID, "110583");
    expect(isPosthogQueryConfigured()).toBe(false);
  });

  test("a project id that is not a number fails the run", () => {
    set(KEY, "phx_test");
    for (const bad of ["asdf", "0", "-3", "11.5", "110583abc"]) {
      set(ID, bad);
      expect(raisesConfigError(isPosthogQueryConfigured)).toBe(true);
    }
  });

  test("blank and whitespace count as unset", () => {
    set(KEY, "phx_test");
    for (const blank of ["", "   "]) {
      set(ID, blank);
      expect(isPosthogQueryConfigured()).toBe(false);
    }
  });
});
