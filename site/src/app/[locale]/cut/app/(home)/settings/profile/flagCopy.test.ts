import { expect, test } from "bun:test";

import settings from "@/i18n/messages/en/settings.json";
import { ACCOUNT_FEATURE_FLAGS } from "@/lib/feature-flags";

// Every flag a person can see renders its switch from the settings catalog, so
// a new flag without its words would show a raw key on the profile page. The
// super-user group stays English and reads the registry's own copy.
test("every registered flag has a title and description in the catalog", () => {
  const flags: Record<string, { title?: string; description?: string }> = settings.flags;
  for (const flag of ACCOUNT_FEATURE_FLAGS.filter((f) => f.group !== "su")) {
    expect(typeof flags[flag.id]?.title).toBe("string");
    expect(typeof flags[flag.id]?.description).toBe("string");
  }
});
