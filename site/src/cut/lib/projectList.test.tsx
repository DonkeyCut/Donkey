import { afterAll, afterEach, beforeEach, describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { UnmentionedRefPills } from "@/cut/components/AssetRefs";
import { attachedAssetsBlock } from "@/cut/server/ai/catalog";
import { runAiTool } from "./aiTools";
import { normalizeRef, refToken } from "./assetRef";
import { bindCutMode, releaseCutMode } from "./backend";
import { projectDocRef } from "./projectLink";
import { listOwnProjects, setHostDocStore } from "./projectReference";
import { useEditor } from "./store";
import type { ProjectSummary } from "./types";
import { WithIntl } from "@/i18n/testing";

// Another project reaches the assistant two ways: an @ attachment that
// carries its id, or a title the model looks up with list_projects.

const summary = (id: string, name: string, updatedAt: number): ProjectSummary => ({
  id,
  name,
  createdAt: 0,
  updatedAt,
  duration: 0,
  clipCount: 0,
  assetCount: 0,
});

const originalFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = originalFetch;
});
afterAll(() => setHostDocStore(null));

describe("list_projects", () => {
  beforeEach(() => {
    setHostDocStore({
      listDocs: async () => [summary("open", "Launch", 3), summary("gfx", "Graphics Ref", 2), summary("old", "Old cut", 1)],
      readDoc: async () => null,
      copyMedia: async (_src, file) => file,
    });
    useEditor.setState({ projectId: "open" });
  });

  test("names every project by its current title and marks the open one", async () => {
    const out = (await runAiTool("list_projects", {})) as { projects: { id: string; name: string; open?: boolean }[]; total: number; unreachable?: string[] };
    expect(out.total).toBe(3);
    // The engine reads only its own disk, and says which shelves it skipped.
    expect(out.unreachable).toEqual(["cloud", "browser"]);
    expect(out.projects.map((p) => [p.id, p.name, p.open ?? false])).toEqual([
      ["open", "Launch", true],
      ["gfx", "Graphics Ref", false],
      ["old", "Old cut", false],
    ]);
  });

  test("pages through a long shelf", async () => {
    const out = (await runAiTool("list_projects", { offset: 1, limit: 1 })) as { projects: { id: string }[]; next?: number };
    expect(out.projects.map((p) => p.id)).toEqual(["gfx"]);
    expect(out.next).toBe(2);
  });
});

describe("the shelves a page lists", () => {
  beforeEach(() => {
    setHostDocStore(null);
    bindCutMode("cloud");
  });
  afterEach(() => releaseCutMode());

  test("the cloud shelf lists newest first", async () => {
    globalThis.fetch = (async () => Response.json([summary("a", "A", 1), summary("b", "B", 5)])) as unknown as typeof fetch;
    const { projects, unreachable } = await listOwnProjects();
    expect(projects.map((p) => [p.id, p.residency])).toEqual([["b", "cloud"], ["a", "cloud"]]);
    expect(unreachable).toEqual([]);
  });

  test("a shelf that does not answer is named", async () => {
    globalThis.fetch = (async () => new Response("", { status: 503 })) as unknown as typeof fetch;
    expect(await listOwnProjects()).toEqual({ projects: [], unreachable: ["cloud"] });
  });
});

describe("a project attachment", () => {
  const ref = projectDocRef({ id: "gfx", name: "Graphics Ref" });

  test("carries the id read_project takes", () => {
    const payload = JSON.parse(decodeURIComponent(ref.url.slice(ref.url.indexOf(",") + 1)));
    expect(payload).toEqual({ tool: "read_project", link: "gfx" });
    // Composer tokens carry no-break spaces so the pill wraps whole.
    expect(refToken(ref).replace(/\u00a0/g, " ")).toBe(`@"Projects / Graphics Ref"`);
  });

  test("comes back from a stored thread", () => {
    expect(normalizeRef({ ...ref })).toMatchObject({ scope: "projectDoc", id: "gfx", name: "Projects / Graphics Ref" });
    expect(normalizeRef({ ...ref, id: "not an id" })).toBeNull();
  });

  test("tells the model to read it by id", () => {
    expect(attachedAssetsBlock([ref])).toContain("Call read_project with that id");
  });

  test("reads as a pill that opens the project in a new tab", () => {
    const html = renderToStaticMarkup(
      <WithIntl>
        <UnmentionedRefPills text="copy its styles" refs={[ref]} />
      </WithIntl>,
    );
    expect(html).toContain("Projects / Graphics Ref");
    expect(html).toContain("/p/gfx");
    expect(html).toContain("target=\"_blank\"");
  });
});
