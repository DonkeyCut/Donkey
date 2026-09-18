import { expect, test } from "bun:test";
import { budgetSteer, stopText, turnClose } from "./turnBudget";

// One policy for every provider: a spent budget carries on, a spent ceiling
// hands back in words, and a token never reaches the chat.

test("a model that signed off is left alone", () => {
  expect(turnClose({ end: "done", spoke: true, extensions: 0 })).toBeNull();
  expect(turnClose({ end: "blocked", spoke: false, extensions: 0 })).toBeNull();
  expect(turnClose({ end: "failed", spoke: false, extensions: 0 })).toBeNull();
});

test("a spent budget carries on, counted", () => {
  const first = turnClose({ end: "budget", spoke: true, extensions: 0, maxExtensions: 3 }) as { steer: string };
  expect(first.steer).toContain("1 of 3");
  const last = turnClose({ end: "budget", spoke: true, extensions: 2, maxExtensions: 3 }) as { steer: string };
  expect(last.steer).toContain("3 of 3");
});

test("the spent ceiling hands off in words", () => {
  const out = turnClose({ end: "budget", spoke: true, extensions: 3, maxExtensions: 3 }) as { signoff: string };
  expect(out.signoff).toContain("keep going");
  expect(out.signoff).not.toContain("max_turns");
});

test("a turn that said nothing still gets an ending", () => {
  const out = turnClose({ end: "done", spoke: false, extensions: 0 }) as { signoff: string };
  expect(out.signoff).toContain("keep going");
});

test("the steer is marked as turn-local scaffolding", () => {
  expect(budgetSteer(1).startsWith("[budget]")).toBe(true);
});

test("a stop with no account of itself still reads as a sentence", () => {
  expect(stopText("Usage limit reached. Try again at 4pm.")).toBe("Usage limit reached. Try again at 4pm.");
  expect(stopText(undefined)).toContain("keep going");
  expect(stopText("   ")).toContain("keep going");
});
