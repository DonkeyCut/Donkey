import { describe, expect, test } from "bun:test";
import { providerFailureClass, type ProviderFailureClass } from "./providerFailure";

const answer = (choice: ProviderFailureClass, p: number) => ({
  choice,
  probabilities: {
    content_refused: choice === "content_refused" ? p : (1 - p) / 2,
    transient_failure: choice === "transient_failure" ? p : (1 - p) / 2,
    other: choice === "other" ? p : (1 - p) / 2,
  },
});

describe("providerFailureClass", () => {
  test("a class that carries the probability is acted on", () => {
    expect(providerFailureClass(answer("content_refused", 0.82))).toBe("content_refused");
    expect(providerFailureClass(answer("transient_failure", 0.61))).toBe("transient_failure");
  });

  test("a winner the judgment spreads thin reads as other", () => {
    expect(providerFailureClass(answer("content_refused", 0.41))).toBe("other");
  });

  test("the floor reads the winner's own probability, never the spread", () => {
    // A clear pick over three options concentrates the distribution loosely:
    // the same answer that reads 0.34 confidence carries 0.8 on its class,
    // and the refusal has to survive so the text-only rung still runs.
    const clear = { choice: "content_refused" as const, probabilities: { content_refused: 0.8, transient_failure: 0.12, other: 0.08 }, confidence: 0.34 };
    expect(providerFailureClass(clear)).toBe("content_refused");
  });

  test("an answer naming a class the distribution does not carry reads as other", () => {
    expect(providerFailureClass({ choice: "content_refused", probabilities: {} })).toBe("other");
  });
});
