import { afterAll, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

// The engine's data root is read per call, so a temp root set before the
// modules load keeps the test off the user's own Movies folder.
const root = await mkdtemp(path.join(os.tmpdir(), "cut-project-delete-test-"));
process.env.DONKEY_CUT_DATA_DIR = root;
const { projectsApi } = await import("./projects");
afterAll(async () => {
  await rm(root, { recursive: true, force: true });
});

const NOT_FOUND = 404;

// A project already gone answers the way every other project route does, so
// the page can tell a delete that found nothing from one that broke.
test("deleting a project that is gone answers not found", async () => {
  const res = await projectsApi.remove(new Request("http://engine/api/cut/projects/gone"), { id: "gone" });

  expect(res.status).toBe(NOT_FOUND);
  expect(await res.json()).toMatchObject({ code: "project_not_found" });
});
