import { describe, expect, test } from "bun:test";
import {
  cancelRevoke,
  forgetRegistered,
  holdRegistered,
  registerBlobFile,
  registeredUrl,
  releaseRegistered,
  resolveRegisteredBlob,
  revokeRegistered,
} from "./registry";

const file = (name: string) => new File(["bytes"], name, { type: "video/mp4" });

describe("blob-URL registry", () => {
  test("a registered path answers with its URL and backing file", () => {
    const path = "/api/cut/projects/p1/media/a.mp4";
    const f = file("a.mp4");
    const url = registerBlobFile(path, f);
    expect(registeredUrl(path)).toBe(url);
    expect(resolveRegisteredBlob(url)).toBe(f);
    revokeRegistered(path);
  });

  test("re-registering a path retires the old URL", () => {
    const path = "/api/cut/projects/p2/media/a.mp4";
    const first = registerBlobFile(path, file("a.mp4"));
    const second = registerBlobFile(path, file("a.mp4"));
    expect(second).not.toBe(first);
    expect(registeredUrl(path)).toBe(second);
    expect(resolveRegisteredBlob(first)).toBe(null);
    revokeRegistered(path);
  });

  test("a prefix revoke sweeps a project's subtree and nothing else", () => {
    const mine = "/api/cut/projects/p3/media/a.mp4";
    const other = "/api/cut/projects/p30/media/b.mp4";
    const mineUrl = registerBlobFile(mine, file("a.mp4"));
    const otherUrl = registerBlobFile(other, file("b.mp4"));
    revokeRegistered("/api/cut/projects/p3/");
    expect(registeredUrl(mine)).toBe(null);
    expect(resolveRegisteredBlob(mineUrl)).toBe(null);
    expect(registeredUrl(other)).toBe(otherUrl);
    revokeRegistered(other);
  });

  test("a hold defers a revoke until its release", () => {
    const path = "/api/cut/projects/p4/media/a.mp4";
    const url = registerBlobFile(path, file("a.mp4"));
    holdRegistered("/api/cut/projects/p4/");
    revokeRegistered("/api/cut/projects/p4/");
    expect(registeredUrl(path)).toBe(url);
    releaseRegistered("/api/cut/projects/p4/");
    expect(registeredUrl(path)).toBe(null);
  });

  test("re-opening cancels a deferred revoke", () => {
    const path = "/api/cut/projects/p5/media/a.mp4";
    const url = registerBlobFile(path, file("a.mp4"));
    holdRegistered("/api/cut/projects/p5/");
    revokeRegistered("/api/cut/projects/p5/");
    cancelRevoke("/api/cut/projects/p5/");
    releaseRegistered("/api/cut/projects/p5/");
    expect(registeredUrl(path)).toBe(url);
    revokeRegistered("/api/cut/projects/p5/");
    expect(registeredUrl(path)).toBe(null);
  });

  test("forgetting a path lands through a hold and frees it for a fresh mint", () => {
    const path = "/api/cut/projects/p6/media/a.mp4";
    const url = registerBlobFile(path, file("a.mp4"));
    holdRegistered("/api/cut/projects/p6/");
    forgetRegistered(path);
    expect(registeredUrl(path)).toBe(null);
    expect(resolveRegisteredBlob(url)).toBe(null);
    const again = registerBlobFile(path, file("a.mp4"));
    expect(again).not.toBe(url);
    releaseRegistered("/api/cut/projects/p6/");
    revokeRegistered(path);
  });

  test("unregistered lookups answer null", () => {
    expect(registeredUrl("/api/cut/projects/none/media/x.mp4")).toBe(null);
    expect(resolveRegisteredBlob("blob:nothing")).toBe(null);
  });
});
