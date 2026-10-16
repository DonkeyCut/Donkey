import { expect, test } from "bun:test";

import { projectsHomeView } from "./projectsHomeView";

const empty = { projects: [], folders: [], error: false, loading: false };
const loading = { projects: null, folders: [], error: false, loading: true };
const idle = { projects: null, folders: [], error: false, loading: false };
const failed = { projects: null, folders: [], error: true, loading: false };
const filled = { projects: [{ id: "p" }], folders: [], error: false, loading: false };

test("an empty shelf waits for the shelves still loading their first answer", () => {
  expect(projectsHomeView([empty, loading])).toBe("loading");
});

test("the empty state shows once every read shelf answered empty", () => {
  expect(projectsHomeView([empty, empty])).toBe("empty");
  expect(projectsHomeView([empty, idle])).toBe("empty");
  expect(projectsHomeView([empty, failed])).toBe("empty");
});

test("cards show as soon as any shelf has them", () => {
  expect(projectsHomeView([filled, loading])).toBe("content");
  expect(projectsHomeView([{ ...empty, folders: [{ id: "f" }] }, loading])).toBe("content");
});

test("nothing answered yet is loading, every shelf failing is failed", () => {
  expect(projectsHomeView([loading, idle])).toBe("loading");
  expect(projectsHomeView([failed, failed])).toBe("failed");
});
