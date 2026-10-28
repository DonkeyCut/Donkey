import { describe, expect, test } from "bun:test";
import { createElement } from "react";
import { renderToString } from "react-dom/server";

import { stubModule } from "@/lib/testing/stubModule";

// A visitor whose session check came back signed out before the page hydrated.
await stubModule("better-auth/react", import.meta.url, {
  createAuthClient: () => ({ useSession: () => ({ data: null, isPending: false }) }),
} as never);
const { useSession } = await import("./auth-client");

function Status() {
  const { data, isPending } = useSession();
  return createElement("span", null, isPending ? "pending" : data ? "signed in" : "signed out");
}

describe("useSession", () => {
  test("renders pending first, the way the static page was served", () => {
    // Hydration renders against the server snapshot; the resolved session
    // lands in the commit after.
    expect(renderToString(createElement(Status))).toBe("<span>pending</span>");
  });
});
