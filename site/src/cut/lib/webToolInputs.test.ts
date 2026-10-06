import { describe, expect, test } from "bun:test";

import { FACT_CLAIMS_CEILING } from "@/lib/inference/factCheck";
import { checkFactsInput } from "./webToolInputs";

describe("check_facts input", () => {
  test("claims are trimmed, emptied ones dropped, repeats kept once", () => {
    expect(checkFactsInput({ claims: ["  The tower is 330 m tall. ", "", "The tower is 330 m tall."], context: " Paris " })).toEqual({
      ok: true,
      claims: ["The tower is 330 m tall."],
      context: "Paris",
    });
  });

  test("claims must be a non-empty list of text", () => {
    expect(checkFactsInput({}).ok).toBe(false);
    expect(checkFactsInput({ claims: [] }).ok).toBe(false);
    expect(checkFactsInput({ claims: "one claim" }).ok).toBe(false);
    expect(checkFactsInput({ claims: [1, 2] }).ok).toBe(false);
    expect(checkFactsInput({ claims: ["  "] }).ok).toBe(false);
  });

  test("an overlong claim and too many claims are refused", () => {
    expect(checkFactsInput({ claims: ["x".repeat(501)] }).ok).toBe(false);
    const many = Array.from({ length: FACT_CLAIMS_CEILING + 1 }, (_, i) => `Claim ${i}`);
    expect(checkFactsInput({ claims: many }).ok).toBe(false);
  });

  test("context must be text", () => {
    expect(checkFactsInput({ claims: ["A"], context: 3 }).ok).toBe(false);
  });
});
