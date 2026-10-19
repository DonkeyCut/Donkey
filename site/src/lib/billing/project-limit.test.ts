import { expect, test } from "bun:test";

import { countedProjects, projectLimitFull } from "./project-limit";

test("the starter project never counts", () => {
  expect(countedProjects(["starter-u1", "a", "b"], "u1")).toBe(2);
  expect(countedProjects(["starter-u2", "a"], "u1")).toBe(2);
});

test("null is no limit; a full limit leaves no room", () => {
  expect(projectLimitFull(500, null)).toBe(false);
  expect(projectLimitFull(0, 0)).toBe(true);
  expect(projectLimitFull(1, 2)).toBe(false);
  expect(projectLimitFull(2, 2)).toBe(true);
});
