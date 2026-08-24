import { describe, expect, test } from "bun:test";

import { fillOutreachText, UnknownPlaceholderError } from "./placeholders";

const vars = {
  balance: "0",
  email: "ada@example.com",
  firstName: "Ada",
  name: "Ada Lovelace",
  spent: "2.4",
};

function refusedPlaceholder(text: string): boolean {
  try {
    fillOutreachText(text, vars);
    return false;
  } catch (e) {
    return e instanceof UnknownPlaceholderError;
  }
}

describe("fillOutreachText", () => {
  test("a placeholder becomes the recipient's value", () => {
    expect(fillOutreachText("Hey {{firstName}}, you spent ${{spent}}.", vars)).toBe(
      "Hey Ada, you spent $2.4.",
    );
  });

  test("spacing inside the braces is allowed", () => {
    expect(fillOutreachText("{{ name }}", vars)).toBe("Ada Lovelace");
  });

  test("text with no placeholders is untouched", () => {
    expect(fillOutreachText("Plain words.", vars)).toBe("Plain words.");
  });

  test("a misspelled placeholder throws instead of mailing the braces", () => {
    expect(refusedPlaceholder("Hey {{frstName}}")).toBe(true);
  });
});

