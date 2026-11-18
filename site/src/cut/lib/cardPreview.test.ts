import { expect, test } from "bun:test";
import { hasCardPreview } from "./cardPreview";

const answering = (status: number, seen: string[] = []) => ({
  fetch: async (path: string, init?: RequestInit) => {
    seen.push(`${path} ${init?.redirect}`);
    return status === 0
      ? Response.redirect("https://r2.example/preview.mp4", 302)
      : new Response(status === 200 ? "mp4" : null, { status });
  },
});

test("a project with no rendered card reads as missing", async () => {
  const seen: string[] = [];
  expect(await hasCardPreview(answering(404, seen), "p 1")).toBe(false);
  expect(seen).toEqual(["/api/cut/projects/p%201/preview manual"]);
});

test("a served card or a cloud redirect to it reads as present", async () => {
  expect(await hasCardPreview(answering(200), "p")).toBe(true);
  expect(await hasCardPreview(answering(0), "p")).toBe(true);
});

test("a failing backend reads as present so it is not handed a render", async () => {
  expect(await hasCardPreview(answering(500), "p")).toBe(true);
});
