import { describe, expect, test } from "bun:test";

import { createTypesafeJudge } from "./typesafe";
import { choice, noul } from "@/lib/inference/judge";

describe("typesafe judge", () => {
  test("is unconfigured without a key and fails hard", async () => {
    const judge = createTypesafeJudge({});
    expect(judge.configured).toBe(false);
    let code = "";
    try {
      await judge.askJudge({ state: "hi", questions: { q: noul("Is this a greeting?") } });
    } catch (error) {
      code = (error as { code: string }).code;
    }
    expect(code).toBe("missing_provider_credentials");
  });

  test("posts state and questions with the pinned model and returns typed answers", async () => {
    let sent: { url: string; body: unknown; auth: string | null } | null = null;
    const judge = createTypesafeJudge({ TYPESAFE_API_KEY: "secret" }, (async (
      url: string | URL | Request,
      init?: RequestInit,
    ) => {
      sent = {
        url: String(url),
        body: JSON.parse(String(init?.body)),
        auth: new Headers(init?.headers).get("authorization"),
      };
      return new Response(
        JSON.stringify({
          model: "jev-1.12",
          answers: {
            intent: { type: "choice", choice: "chat", probabilities: { chat: 0.9, work: 0.1 }, confidence: 0.85 },
            urgent: { type: "noul", noul: 0.05 },
          },
          usage: { input_tokens: 40, output_tokens: 2 },
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }) as typeof fetch);

    const result = await judge.askJudge({
      state: "hello there",
      questions: {
        intent: choice("What kind of message?", { chat: "social filler", work: "an ask" }),
        urgent: noul("Is it urgent?"),
      },
    });
    expect(result.model).toBe("jev-1.12");
    expect(result.answers.intent.choice).toBe("chat");
    expect(result.answers.intent.probabilities.work).toBe(0.1);
    expect(result.answers.urgent.noul).toBe(0.05);
    expect(result.usage.input_tokens).toBe(40);
    const s = sent as unknown as { url: string; body: { model: string; state: string }; auth: string | null };
    expect(s.url).toBe("https://api.typesafe.ai/v1/systemone");
    expect(s.body.model).toBe("jev-latest");
    expect(s.body.state).toBe("hello there");
    expect(s.auth).toBe("Bearer secret");
  });

  test("a provider failure surfaces as an inference provider error", async () => {
    const judge = createTypesafeJudge({ TYPESAFE_API_KEY: "secret" }, (async () =>
      new Response(JSON.stringify({ error: "bad" }), { status: 422 })) as typeof fetch);
    let code = "";
    try {
      await judge.askJudge({ state: "x", questions: { q: noul("?") } });
    } catch (error) {
      code = (error as { code: string }).code;
    }
    expect(code).toBe("invalid_request");
  });
});
