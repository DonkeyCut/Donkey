import { afterAll, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { ProjectDoc } from "@/cut/lib/types";

// The engine's data root is read per call, so a temp root set before the
// module loads keeps the test off the user's own Movies folder.
const root = await mkdtemp(path.join(os.tmpdir(), "cut-summary-test-"));
process.env.DONKEY_CUT_DATA_DIR = root;
const projects = await import("./projects");
afterAll(async () => { await rm(root, { recursive: true, force: true }); });

test("a project card's length is where its timeline ends", async () => {
  // Two 1 s clips with a 2 s gap between them, the second at double speed,
  // and a title standing after both: the timeline runs to 6 s.
  const { id } = await projects.createProject("Card Length");
  const doc = (await projects.readProject(id)) as ProjectDoc;
  const clip = { assetId: "a", in: 0, out: 1, track: 0 };
  await projects.writeProject(id, {
    ...doc,
    clips: [
      { ...clip, id: "c1", start: 0 },
      { ...clip, id: "c2", start: 3, out: 2, speed: 2 },
    ],
    overlays: [{ id: "t", kind: "text", start: 5, end: 6 }],
  } as unknown as ProjectDoc);

  const card = (await projects.listProjects()).find((p) => p.id === id);
  expect(card?.duration).toBeCloseTo(6, 5);
});
