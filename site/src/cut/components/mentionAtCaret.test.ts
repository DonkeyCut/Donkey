import { expect, test } from "bun:test";
import { mentionAtCaret } from "./AssetRefs";

// "@" opens a mention; "@" followed by a space is the character itself, so
// the picker steps aside for text like "meet @ 3pm".
test("an @ opens a mention and an @ before a space stays text", () => {
  expect(mentionAtCaret("@", 1)).toEqual({ start: 0, query: "" });
  expect(mentionAtCaret("use @cli", 8)).toEqual({ start: 4, query: "cli" });
  expect(mentionAtCaret("meet @ 3pm", 10)).toBeNull();
  expect(mentionAtCaret("@ ", 2)).toBeNull();
});
