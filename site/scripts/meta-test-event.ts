#!/usr/bin/env bun
/**
 * Sends one CompleteRegistration through the production Conversions API path
 * to the Donkey Cut dataset's Test events tab, which shows it within seconds
 * and keeps it out of reporting. The test code is on that tab.
 *
 * Run from site/ with META_PIXEL_ID and META_CAPI_ACCESS_TOKEN in the environment:
 *   bun run scripts/meta-test-event.ts <TEST_CODE>
 */

import { sendMetaEvent } from "../src/lib/meta/conversions";

const testCode = process.argv[2];
if (!testCode) {
  console.error("usage: bun run scripts/meta-test-event.ts <TEST_CODE>");
  process.exit(1);
}

await sendMetaEvent(
  {
    browser: {
      fbp: `fb.1.${Date.now()}.1234567890`,
      ip: "203.0.113.7",
      userAgent: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 Safari/605.1.15",
    },
    id: `test-${crypto.randomUUID()}`,
    name: "CompleteRegistration",
    url: "https://donkeycut.com/sign-up",
    user: { email: "test@example.com", id: "meta-test-event" },
  },
  testCode,
);
console.log("sent; check the Test events tab");
