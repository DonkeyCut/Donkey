import { describe, expect, test } from "bun:test";

import { NO_CREDITS_MESSAGE } from "./credits";
import { readHostedError } from "./hostedError";

const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status });

describe("readHostedError", () => {
  test("401 asks to sign in and 402 says the credits line", async () => {
    expect(await readHostedError(json(401, { message: "x" }), "Sign in.", "Failed.")).toBe("Sign in.");
    expect(await readHostedError(json(402, { message: "x" }), "Sign in.", "Failed.")).toBe(NO_CREDITS_MESSAGE);
  });

  test("the provider's reason joins the headline", async () => {
    const res = json(502, { message: "Generation failed.", details: { message: "Prompt was filtered." } });
    expect(await readHostedError(res, "Sign in.", "Failed.")).toBe("Generation failed. (Prompt was filtered.)");
    expect(await readHostedError(json(502, { details: { message: "Rate limited." } }), "Sign in.", "Failed.")).toBe(
      "Rate limited.",
    );
  });

  test("a rejected request names its first bad field before the generic error", async () => {
    const res = json(400, { error: "Invalid request", issues: [{ path: "claims.0", message: "Too long" }] });
    expect(await readHostedError(res, "Sign in.", "Failed.")).toBe("claims.0: Too long");
  });

  test("an unreadable body falls back", async () => {
    expect(await readHostedError(new Response("oops", { status: 500 }), "Sign in.", "Failed.")).toBe("Failed.");
  });
});
