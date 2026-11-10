import { describe, expect, test } from "bun:test";

import { sharedBackendFor, templateBackendFor } from "./shared";

describe("sharedBackendFor", () => {
  test("rewrites the engine's route shapes under its own share", () => {
    const a = sharedBackendFor("tok-a");
    const b = sharedBackendFor("tok b");
    expect(a.url("/api/cut/projects/p1")).toBe("/api/cut-shared/tok-a/projects/p1");
    expect(a.url("/api/cut/projects/p1/media/clip%201.mp4")).toBe(
      "/api/cut-shared/tok-a/projects/p1/media/clip%201.mp4"
    );
    expect(b.url("/api/cut/projects/p1")).toBe("/api/cut-shared/tok%20b/projects/p1");
  });

  test("the bare prefix is the share's own meta route", () => {
    expect(sharedBackendFor("tok").url("/api/cut/")).toBe("/api/cut-shared/tok");
    expect(sharedBackendFor("tok").url("/api/cut")).toBe("/api/cut-shared/tok");
  });
});

describe("templateBackendFor", () => {
  test("rewrites the engine's route shapes under the template's prefix", () => {
    const t = templateBackendFor("launch-teaser");
    expect(t.url("/api/cut")).toBe("/api/templates/launch-teaser");
    expect(t.url("/api/cut/projects/launch-teaser/media/a.mp4")).toBe(
      "/api/templates/launch-teaser/projects/launch-teaser/media/a.mp4"
    );
  });
});
