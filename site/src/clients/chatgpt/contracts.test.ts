import { describe, expect, test } from "bun:test";
import { viewSchema } from "./contracts";

const project = { id: "p1", name: "Launch film", url: "https://donkeycut.com/app/p/p1", revision: "cloud:2" };
const base = { canRender: true, canEdit: false, results: [], changed: false, project: null, preview: null, export: null, job: null, history: null, account: null, nextCursor: null };
const views = [
  { ...base, view: "projects", projects: [project] },
  { ...base, view: "project", projects: [], project, preview: { id: "j1", status: "done", progress: 1, revision: null } },
  { ...base, view: "project", projects: [], project, export: { id: "e1", status: "running", progress: 0.5, name: null }, history: { undo: "Trim", redo: null }, account: { credits: "3.00", storageBytes: 10, storageQuotaBytes: null, plan: "free" } },
];

/** What ChatGPT's sandbox hands the widget: every null-valued key removed. */
const dropNulls = (value: unknown): unknown =>
  Array.isArray(value) ? value.map(dropNulls)
    : value && typeof value === "object" ? Object.fromEntries(Object.entries(value).filter(([, v]) => v !== null).map(([k, v]) => [k, dropNulls(v)]))
    : value;

describe("widget view contract", () => {
  test("parses a view with nulls and the same view with its null keys dropped", () => {
    for (const view of views) {
      expect(viewSchema.safeParse(view).success).toBe(true);
      const stripped = viewSchema.safeParse(dropNulls(view));
      expect(stripped.success).toBe(true);
    }
  });
});
