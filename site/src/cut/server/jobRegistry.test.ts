import { expect, test } from "bun:test";
import { createJobRegistry } from "./jobRegistry";

test("preview resources are evicted once across backlog trimming and expiry", async () => {
  const key = `__previewRegistryTest_${crypto.randomUUID()}`;
  const evicted: string[] = [];
  const registry = createJobRegistry<{ id: string; status: string }>(key, {
    maxJobs: 1, retireMs: 5, onEvict: (job) => { evicted.push(job.id); },
  });
  for (const id of ["a", "b"]) {
    const job = { id, status: "done" };
    registry.jobs.set(id, job);
    registry.retire(job);
  }
  expect(evicted).toEqual(["a"]);
  await new Promise((resolve) => setTimeout(resolve, 15));
  expect(evicted).toEqual(["a", "b"]);
  expect(registry.jobs.size).toBe(0);
  delete (globalThis as unknown as Record<string, unknown>)[key];
});
