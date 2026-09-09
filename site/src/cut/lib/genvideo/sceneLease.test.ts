import { expect, test } from "bun:test";
import { SceneOwnedElsewhere, withSceneLease } from "./sceneLease";

test("a second scene owner cannot start work", async () => {
  let ran = false;
  const run = withSceneLease(async () => false, async () => { ran = true; }, () => {}, 1);
  expect(await run.catch((error) => error) instanceof SceneOwnedElsewhere).toBe(true);
  expect(ran).toBe(false);
});

test("a pending renewal completes before the lease is released", async () => {
  const events: string[] = [];
  let renewed!: () => void;
  let started!: () => void;
  const renewalStarted = new Promise<void>((resolve) => { started = resolve; });
  let finish!: () => void;
  let acquired = false;
  const result = withSceneLease(async (release) => {
    if (release) { events.push("released"); return false; }
    if (!acquired) { acquired = true; return true; }
    started();
    await new Promise<void>((resolve) => { renewed = resolve; });
    events.push("renewed");
    return true;
  }, () => new Promise<void>((resolve) => { finish = resolve; }), () => {}, 1);
  await renewalStarted;
  finish();
  await Promise.resolve();
  expect(events.length).toBe(0);
  renewed();
  await result;
  expect(events).toEqual(["renewed", "released"]);
});

test("losing the lease stops the current owner", async () => {
  let acquired = false;
  let finish!: () => void;
  let stopped = false;
  const result = withSceneLease(async (release) => {
    if (release || acquired) return false;
    acquired = true;
    return true;
  }, () => new Promise<void>((resolve) => { finish = resolve; }), () => { stopped = true; finish(); }, 1);
  expect(await result.catch((error) => error) instanceof SceneOwnedElsewhere).toBe(true);
  expect(stopped).toBe(true);
});
