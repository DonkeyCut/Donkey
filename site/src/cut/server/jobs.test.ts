import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

// The engine's data root is read per call, so a temp root set before the
// modules load keeps the test off the user's own Movies folder.
const root = await mkdtemp(path.join(os.tmpdir(), "cut-jobs-test-"));
process.env.DONKEY_CUT_DATA_DIR = root;
const jobs = await import("./jobs");
const projects = await import("./projects");

const exists = (file: string) =>
  stat(file).then(
    () => true,
    () => false
  );

const bytes = (text: string) =>
  new ReadableStream<Uint8Array>({
    start(c) {
      c.enqueue(new TextEncoder().encode(text));
      c.close();
    },
  });

describe("a render the tab carries itself", () => {
  let projectId = "";
  beforeAll(async () => {
    projectId = (await projects.createProject("Tab Render")).id;
  });
  afterAll(async () => {
    await rm(root, { recursive: true, force: true });
  });

  test("holds a name and a running row, then lands the file under that name", async () => {
    const job = await jobs.createClientJob(projectId, "mp4");
    expect(job.status).toBe("running");
    expect(job.outName).toBe("Tab Render.mp4");
    expect(jobs.listAllJobs().find((j) => j.id === job.id)?.status).toBe("running");

    jobs.progressClientJob(job.id, 0.5);
    expect(jobs.getJob(job.id)?.progress).toBe(0.5);

    const done = await jobs.completeClientJob(job.id, bytes("mp4 bytes"));
    expect(done?.status).toBe("done");
    expect(done?.progress).toBe(1);
    const file = path.join(projects.exportsDir(projectId), "Tab Render.mp4");
    expect(await readFile(file, "utf8")).toBe("mp4 bytes");
    expect(await exists(`${file}.part`)).toBe(false);
  });

  test("a second render takes the next name while the first holds its own", async () => {
    const job = await jobs.createClientJob(projectId, "mp4");
    expect(job.outName).toBe("Tab Render 2.mp4");
    jobs.releaseClientJob(job.id);
    expect(jobs.getJob(job.id)).toBeUndefined();
    const again = await jobs.createClientJob(projectId, "mov");
    expect(again.outName).toBe("Tab Render.mov");
    jobs.releaseClientJob(again.id);
  });

  test("a cancel from another dock settles the row and refuses the file", async () => {
    const job = await jobs.createClientJob(projectId, "mp4");
    jobs.cancelJob(job.id);
    expect(jobs.getJob(job.id)?.status).toBe("error");
    expect(await jobs.completeClientJob(job.id, bytes("late"))).toBeNull();
    expect(await exists(path.join(projects.exportsDir(projectId), "Tab Render 2.mp4"))).toBe(false);
  });

  test("a tab that fell silent gives its row and name up", async () => {
    const job = await jobs.createClientJob(projectId, "mp4");
    jobs.progressClientJob(job.id, 0.4);
    jobs.sweepClientJobsForTest(Date.now() + 60_000);
    expect(jobs.getJob(job.id)?.status).toBe("running");
    jobs.sweepClientJobsForTest(Date.now() + 10 * 60_000);
    expect(jobs.getJob(job.id)?.status).toBe("error");
    expect(jobs.listAllJobs().find((j) => j.id === job.id)?.status).toBe("error");
    // "Tab Render.mp4" is on disk from the first render; the silent job's
    // name is free again.
    const next = await jobs.createClientJob(projectId, "mp4");
    expect(next.outName).toBe("Tab Render 2.mp4");
    jobs.releaseClientJob(next.id);
    jobs.releaseClientJob(job.id);
  });

  test("a hand-in that broke off leaves no row once the tab releases it", async () => {
    const job = await jobs.createClientJob(projectId, "mp4");
    // A request body whose connection dropped mid-stream.
    const broken = new ReadableStream<Uint8Array>({
      start(c) {
        c.enqueue(new TextEncoder().encode("half"));
      },
      pull(c) {
        c.error(new Error("aborted"));
      },
    });
    const settled = await jobs.completeClientJob(job.id, broken);
    expect(settled?.status).toBe("error");
    expect(await exists(path.join(projects.exportsDir(projectId), "Tab Render.mp4.part"))).toBe(false);
    jobs.releaseClientJob(job.id);
    expect(jobs.getJob(job.id)).toBeUndefined();
  });

  test("an unknown project is refused up front", async () => {
    const job = await jobs.createClientJob("nope", "mp4");
    expect(job.status).toBe("error");
  });
});
