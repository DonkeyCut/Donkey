import { describe, expect, test } from "bun:test";

process.env.BETTER_AUTH_SECRET ??= "test-secret";

import {
  outreachIdFromReplyAddress,
  outreachIdFromRecipients,
  outreachReplyAddress,
} from "./replyAddress";

const id = "cmf0z8k9x0000abcdefghijkl";

describe("outreachReplyAddress", () => {
  test("an address it signed reads back as its row id", () => {
    expect(outreachIdFromReplyAddress(outreachReplyAddress(id))).toBe(id);
  });

  test("the local part stays inside the 64-octet limit", () => {
    const local = outreachReplyAddress(id).split("@")[0];
    expect(local.length).toBeLessThanOrEqual(64);
  });

  test("a guessed row id without a signature is refused", () => {
    expect(outreachIdFromReplyAddress(`outreach+${id}.deadbeef@reply.donkeycut.com`)).toBeNull();
  });

  test("another row's signature does not carry over", () => {
    const sig = outreachReplyAddress("other-row").split("@")[0].split(".")[1];
    expect(outreachIdFromReplyAddress(`outreach+${id}.${sig}@reply.donkeycut.com`)).toBeNull();
  });

  test("an address on another host is not ours", () => {
    const local = outreachReplyAddress(id).split("@")[0];
    expect(outreachIdFromReplyAddress(`${local}@donkeycut.com`)).toBeNull();
  });

  test("recipients are searched past unrelated addresses and display names", () => {
    expect(
      outreachIdFromRecipients(
        ["support@donkeycut.com"],
        [`Donkey <${outreachReplyAddress(id)}>`],
      ),
    ).toBe(id);
  });

  test("mail addressed to nobody we know reads as no row", () => {
    expect(outreachIdFromRecipients(["hi@donkeycut.com"], [])).toBeNull();
  });
});
