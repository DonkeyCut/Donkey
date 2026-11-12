import { expect, test } from "bun:test";
import { reconcileDoc } from "./docReconcile";
import type { ProjectDoc } from "./types";

const clip = (id: string, start: number, extra: Record<string, unknown> = {}) => ({ id, assetId: "a", start, in: 0, out: 2, track: 0, ...extra });
const doc = (fields: Record<string, unknown>) => fields as Partial<ProjectDoc>;

test("each side's edits land on the other's", () => {
  const base = doc({ name: "Cut", aspect: "9:16", clips: [clip("c1", 0), clip("c2", 2)] });
  // The person trimmed c1 and renamed the project; the agent squared the
  // frame and turned c2 down.
  const mine = doc({ name: "Cats", aspect: "9:16", clips: [clip("c1", 0, { out: 1 }), clip("c2", 2)] });
  const theirs = doc({ aspect: "1:1", name: "Cut", clips: [clip("c1", 0), clip("c2", 2, { volume: 0.5 })] });
  expect(reconcileDoc(base, mine, theirs)).toEqual({
    name: "Cats",
    aspect: "1:1",
    clips: [clip("c1", 0, { out: 1 }), clip("c2", 2, { volume: 0.5 })],
  });
});

test("additions from both sides are kept, each where it was placed", () => {
  const base = doc({ clips: [clip("c1", 0), clip("c2", 2)] });
  const mine = doc({ clips: [clip("c1", 0), clip("mine", 1), clip("c2", 2)] });
  const theirs = doc({ clips: [clip("c1", 0), clip("c2", 2), clip("theirs", 4)] });
  expect(reconcileDoc(base, mine, theirs).clips?.map((c) => c.id)).toEqual(["c1", "mine", "c2", "theirs"]);
});

test("a removal on either side holds, unless the other side changed the item", () => {
  const base = doc({ clips: [clip("c1", 0), clip("c2", 2), clip("c3", 4)] });
  // The person removed c1; the agent removed c2 and c3, but the person had
  // just trimmed c3.
  const mine = doc({ clips: [clip("c2", 2), clip("c3", 4, { out: 1 })] });
  const theirs = doc({ clips: [clip("c1", 0)] });
  expect(reconcileDoc(base, mine, theirs).clips?.map((c) => c.id)).toEqual(["c3"]);
});

test("the same value changed on both sides keeps this tab's", () => {
  const base = doc({ background: "#000", clips: [clip("c1", 0)] });
  const mine = doc({ background: "#fff", clips: [clip("c1", 0, { out: 1 })] });
  const theirs = doc({ background: "#f00", clips: [clip("c1", 0, { out: 3 })] });
  expect(reconcileDoc(base, mine, theirs)).toEqual(mine);
});

test("key order and dropped empty fields from the database are no change", () => {
  const base = doc({ genvideo: null, publish: { caption: "", tags: "" }, clips: [clip("c1", 0)] });
  const mine = doc({ genvideo: null, publish: { caption: "Hi", tags: "" }, clips: [clip("c1", 0)] });
  const theirs = doc({ publish: { tags: "", caption: "" }, clips: [{ track: 0, out: 2, in: 0, start: 0, assetId: "a", id: "c1" }] });
  expect(reconcileDoc(base, mine, theirs)).toEqual(mine);
});

test("fields only the stored copy carries stay out", () => {
  const merged = reconcileDoc(doc({ name: "Cut" }), doc({ name: "Cut" }), doc({ name: "Cut", updatedAt: 5, folderId: "f" }));
  expect(merged).toEqual({ name: "Cut" });
});
