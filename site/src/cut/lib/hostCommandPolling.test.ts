import { expect, test } from "bun:test";
import { hostCommandPoller } from "./hostCommandPolling";
import { SETTINGS } from "@/lib/config/registry";

const settings = () => SETTINGS.chatgptPolling.default;

test("failed polls back off, remain bounded, and reset after recovery", async () => {
  let status = 500;
  const poll = hostCommandPoller({
    claim: async () => new Response(null, { status }),
    run: async () => {}, settings, hidden: () => false,
  });
  expect(await poll()).toBe(2000);
  expect(await poll()).toBe(4000);
  expect(await poll()).toBe(8000);
  for (let i = 0; i < 8; i++) await poll();
  expect(await poll()).toBe(60000);
  status = 204;
  expect(await poll()).toBe(1000);
  status = 503;
  expect(await poll()).toBe(2000);
});

test("expired sessions and inaccessible projects stop the polling loop", async () => {
  for (const status of [401, 403, 404]) {
    const poll = hostCommandPoller({
      claim: async () => new Response(null, { status }),
      run: async () => { throw new Error("Must not run"); }, settings, hidden: () => true,
    });
    expect(await poll()).toBeNull();
  }
});

test("network failures and Retry-After delay the next attempt", async () => {
  let networkFailure = true;
  const poll = hostCommandPoller({
    claim: async () => {
      if (networkFailure) throw new TypeError("Offline");
      return new Response(null, { status: 429, headers: { "Retry-After": "120" } });
    },
    run: async () => {}, settings, hidden: () => true,
  });
  expect(await poll()).toBe(6000);
  networkFailure = false;
  expect(await poll()).toBe(120000);
});

test("the next claim waits for the current batch to finish", async () => {
  let finish!: () => void;
  const completed = new Promise<void>((resolve) => { finish = resolve; });
  let ran = false;
  let returned = false;
  const poll = hostCommandPoller({
    claim: async () => Response.json({ id: "job", spec: { commands: [], readOnly: true } }),
    run: async (job) => { expect(job.id).toBe("job"); ran = true; await completed; },
    settings, hidden: () => false,
  });
  const next = poll().then((delay) => { returned = true; return delay; });
  await new Promise((resolve) => setTimeout(resolve, 0));
  expect(ran).toBe(true);
  expect(returned).toBe(false);
  finish();
  expect(await next).toBe(0);
});
