import { describe, expect, test } from "bun:test";

import { NO_CREDITS_MESSAGE } from "./credits";
import { readHostedFailure } from "./hostedError";
import { UserError } from "./userError";

const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status });
const signIn = new UserError("sign_in", "Sign in.");
const failed = new UserError("failed", "Failed.");
const read = async (res: Response) => (await readHostedFailure(res, signIn, failed)).message;

describe("readHostedFailure", () => {
  test("401 asks to sign in and 402 says the credits line", async () => {
    expect(await readHostedFailure(json(401, { message: "x" }), signIn, failed)).toBe(signIn);
    const wall = await readHostedFailure(json(402, { message: "x" }), signIn, failed);
    expect(wall.message).toBe(NO_CREDITS_MESSAGE);
    expect((wall as UserError).code).toBe("credits_insufficient");
  });

  test("the provider's reason joins the headline", async () => {
    const res = json(502, { message: "Generation failed.", details: { message: "Prompt was filtered." } });
    expect(await read(res)).toBe("Generation failed. (Prompt was filtered.)");
    expect(await read(json(502, { details: { message: "Rate limited." } }))).toBe("Rate limited.");
  });

  test("a rejected request names its first bad field before the generic error", async () => {
    const res = json(400, { error: "Invalid request", issues: [{ path: "claims.0", message: "Too long" }] });
    expect(await read(res)).toBe("claims.0: Too long");
  });

  test("an unreadable body falls back", async () => {
    expect(await readHostedFailure(new Response("oops", { status: 500 }), signIn, failed)).toBe(failed);
  });
});
