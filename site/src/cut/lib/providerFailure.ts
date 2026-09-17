import { askJudge, choice } from "./judge";
import { hostedPost } from "./hosted";

// What a provider's failure means, judged from its own error text. A render
// or a music call fails for one of three reasons that call for different
// next steps: the provider declined the content (a policy or safety ground,
// an unreadable input image), something transient a retry could clear, or
// anything else. The error text is the provider's, never the user's words.

export type ProviderFailureClass = "content_refused" | "transient_failure" | "other";

export const PROVIDER_FAILURE_QUESTION = choice(
  "A hosted media provider answered a generation request with the error in `error`. Why did the request fail?",
  {
    content_refused:
      "The provider declined the content itself on a policy or safety ground: a blocked or sensitive prompt, a refused or unreadable input image (a face, a person, a format it cannot read), or a completed render whose output was filtered and returned nothing.",
    transient_failure: "A timeout, an overload, a quota or rate limit, or a network error that a retry could clear.",
    other: "Any other failure: a bad request, a missing parameter, an internal error with no policy or transient cause named.",
  },
);

/** The probability the named class has to carry to be acted on. */
const COMMIT_FLOOR = 0.5;

/** Classify a failure's cause from the judge's answer. The class commits on
 * its own probability; a winner the judgment spreads thin reads as "other". */
export function providerFailureClass(answer: {
  choice: ProviderFailureClass;
  probabilities: Record<string, number>;
}): ProviderFailureClass {
  return (answer.probabilities[answer.choice] ?? 0) >= COMMIT_FLOOR ? answer.choice : "other";
}

/** The failure class of a provider error, judged through the hosted judge.
 * A judgment that cannot be made reads as "other", which is what a missed
 * pattern meant before. */
export async function classifyProviderFailure(error: string): Promise<ProviderFailureClass> {
  try {
    const { answers } = await askJudge(
      (payload, signal) => hostedPost("/api/inference/judge", payload, signal),
      { error: error.slice(0, 2000) },
      { cause: PROVIDER_FAILURE_QUESTION },
    );
    return providerFailureClass(answers.cause);
  } catch {
    return "other";
  }
}
