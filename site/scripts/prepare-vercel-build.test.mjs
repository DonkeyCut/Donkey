import assert from "node:assert/strict";
import { test } from "node:test";
import { parse } from "dotenv";
import { buildKeys, prepareBuildEnvironment } from "./prepare-vercel-build.mjs";

const credentials = Object.fromEntries(buildKeys.map(key => [key, `test-${key}`]));

test("replaces build credentials and removes unreadable runtime secrets", () => {
  const result = parse(prepareBuildEnvironment(
    'DATABASE_URL="[SENSITIVE]"\nOPENAI_API_KEY="[SENSITIVE]"\nVERCEL_ENV="production"\n',
    credentials,
  ));
  assert.equal(result.DATABASE_URL, credentials.DATABASE_URL);
  assert.equal(result.NEXT_PUBLIC_POSTHOG_KEY, credentials.NEXT_PUBLIC_POSTHOG_KEY);
  assert.equal(result.VERCEL_ENV, "production");
  assert.equal(result.OPENAI_API_KEY, undefined);
});

test("refuses missing build values and unresolved public placeholders", () => {
  for (const missing of [undefined, "", "[SENSITIVE]", 42]) {
    assert.throws(() => prepareBuildEnvironment("", { ...credentials, DATABASE_URL: missing }), /missing DATABASE_URL/);
  }
  assert.throws(() => prepareBuildEnvironment('NEXT_PUBLIC_NEW_KEY="[SENSITIVE]"', credentials), /NEXT_PUBLIC_NEW_KEY/);
  assert.throws(() => prepareBuildEnvironment("", null), /JSON object/);
});

test("preserves quoted and multiline credential values", () => {
  const value = 'key"with\\slashes\nand-newlines';
  const result = parse(prepareBuildEnvironment("", { ...credentials, BETTER_AUTH_SECRET: value }));
  assert.equal(result.BETTER_AUTH_SECRET, value);
});
