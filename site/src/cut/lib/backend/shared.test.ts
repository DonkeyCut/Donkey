import { describe, expect, test } from "bun:test";

import { sharedBackendFor } from "./shared";

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
