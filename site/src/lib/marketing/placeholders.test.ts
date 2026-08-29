import { describe, expect, test } from "bun:test";

import {
  fillOutreachText,
  OUTREACH_PLACEHOLDERS,
  UnknownPlaceholderError,
} from "./placeholders";

const vars = {
  balance: "0",
  email: "ada@example.com",
  firstName: "Ada",
  name: "Ada Lovelace",
  spent: "2.4",
  storage: "120 MB",
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

  // The button row offers every name in the list, so every one of them has to
  // resolve to a value; a name the send path forgets to supply would mail the
  // word "undefined" to a real person.
  test("every offered placeholder fills with the recipient's value", () => {
    for (const name of OUTREACH_PLACEHOLDERS) {
      const filled = fillOutreachText(`{{${name}}}`, vars);
      expect(filled).not.toBe("");
      expect(filled).not.toContain("undefined");
    }
  });
});

