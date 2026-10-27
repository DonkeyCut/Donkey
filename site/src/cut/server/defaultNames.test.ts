import { afterAll, expect, test } from "bun:test";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { translatorFor } from "@/i18n/translator";

// A project the engine creates without a name is named in its creator's
// language: the create request's locale picks the catalog. The temp data
// root keeps the test off the user's own Movies folder.
const root = await mkdtemp(path.join(os.tmpdir(), "cut-default-names-test-"));
process.env.DONKEY_CUT_DATA_DIR = root;
const { projectsApi } = await import("./http/projects");
const projects = await import("./projects");
afterAll(async () => { await rm(root, { recursive: true, force: true }); });

const create = async (body: Record<string, unknown>) => {
  const req = new Request("http://engine/api/cut/projects", { method: "POST", body: JSON.stringify(body) });
  return (await (await projectsApi.create(req)).json()) as { id: string; name: string };
};

test("a headless project created in ja is named from the ja catalog", async () => {
  const t = await translatorFor("ja", "errors");
  const first = await create({ locale: "ja" });
  const second = await create({ locale: "ja" });

  expect(first.name).toBe(t("defaults.untitled"));
  expect(second.name).toBe(t("defaults.untitled"));

  // Two untitled projects take "<base>" and "<base> 2" folders in that language.
  const dirs = await readdir(path.join(root, "projects"));
  expect(dirs).toContain(t("defaults.untitled"));
  expect(dirs).toContain(`${t("defaults.untitled")} 2`);
});

test("a create without a locale is named in the default language", async () => {
  const t = await translatorFor("en", "errors");
  expect((await create({})).name).toBe(t("defaults.untitled"));
});

test("a duplicate is named in its creator's language", async () => {
  const t = await translatorFor("ja", "errors");
  const { id } = await create({ name: "Trip" });
  const req = new Request(`http://engine/api/cut/projects/${id}/duplicate`, {
    method: "POST",
    body: JSON.stringify({ locale: "ja" }),
  });
  const copy = (await (await projectsApi.duplicate(req, { id })).json()) as { id: string };
  expect((await projects.readProject(copy.id))?.name).toBe(t("defaults.copy", { name: "Trip" }));
});
