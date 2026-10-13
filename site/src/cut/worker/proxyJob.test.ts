import { describe, expect, mock, test } from "bun:test";
import { writeFile } from "node:fs/promises";
import type { prisma } from "@/lib/prisma";
import type { RenderHandle } from "../server/exportPipeline";
import { runProxyJob, type ProxyJobIO } from "./proxyJob";
import { PROXY_SOURCE_FAULT } from "../lib/proxyNames";
import { InputFault } from "./settle";

function harness(taken: string[] = [], spec: Record<string, unknown> = { file: "clip.mov" }) {
  const findMany = mock(async (_args: unknown) => { void _args; return taken.map((fileName) => ({ fileName })); });
  const io = {
    db: { cutMediaObject: { findMany } } as unknown as typeof prisma,
    download: mock(async (_key: string, file: string) => { await writeFile(file, "master"); }),
    upload: mock(async (_key: string, _file: string, _mime: string) => { void _file; void _mime; return 7; }),
    remove: mock(async (_keys: string[]) => { void _keys; }),
    register: mock(async (object: { fileName: string }) => object.fileName),
    unregister: mock(async (_user: string, _keys: string[]) => { void _keys; }),
    make: mock(async (_handle: unknown, _src: string, out: string, opts: { maxHeight: number; crf: number; onProgress?: (s: number) => void }) => {
      opts.onProgress?.(1);
      await writeFile(out, "proxy");
      return { sizeBytes: 5, width: 64, height: 64 };
    }),
    duration: mock(async () => 2),
    settings: mock(async () => ({ proxyMaxHeight: 1080, proxyCrf: 20, lightKbps: 6000 })),
  } satisfies ProxyJobIO;
  const job = { id: "proxy-1", userId: "owner", projectId: "project", kind: "proxy", outName: null, spec };
  const handle: RenderHandle = { tmpDir: "", outPath: "", progress: 0, log: [] as string[] };
  const run = (canceled = () => false) => runProxyJob(job, handle, canceled, io);
  return { run, io, handle, findMany };
}

describe("proxy worker", () => {
  test("a heavy video's job builds the capped light copy under its own name", async () => {
    const h = harness([], { file: "clip.mov", maxHeight: 1080 });
    expect((await h.run()).fileName).toBe("clip.mov.light.mp4");
    expect(h.io.make.mock.calls[0][3]).toMatchObject({ maxHeight: 1080, maxKbps: 6000 });
    // A ProRes job keeps the full-quality proxy, uncapped.
    const pro = harness();
    expect((await pro.run()).fileName).toBe("clip.proxy.mp4");
    expect((pro.io.make.mock.calls[0][3] as { maxKbps?: number }).maxKbps).toBeUndefined();
  });

  test("a job that asks for a smaller copy gets it, never one past the account's size", async () => {
    const small = harness([], { file: "clip.mov", maxHeight: 720 });
    await small.run();
    expect(small.io.make.mock.calls[0][3]).toMatchObject({ maxHeight: 720 });
    const big = harness([], { file: "clip.mov", maxHeight: 4320 });
    await big.run();
    expect(big.io.make.mock.calls[0][3]).toMatchObject({ maxHeight: 1080 });
  });

  test("builds the proxy at the account's size and quality and registers it exempt beside the master", async () => {
    const h = harness();
    expect(await h.run()).toEqual({ fileName: "clip.proxy.mp4", sizeBytes: 5, width: 64, height: 64 });
    expect(h.io.download.mock.calls[0][0]).toBe("cut/owner/projects/project/media/clip.mov");
    expect(h.io.make.mock.calls[0][3]).toMatchObject({ maxHeight: 1080, crf: 20 });
    expect(h.io.upload.mock.calls[0][0]).toBe("cut/owner/projects/project/media/clip.proxy.mp4");
    expect(h.io.register.mock.calls[0][0]).toMatchObject({
      userId: "owner",
      projectId: "project",
      fileName: "clip.proxy.mp4",
      kind: "proxy",
      mime: "video/mp4",
      bytes: 7,
    });
    expect(h.handle.progress).toBeGreaterThan(0);
  });

  test("dedupes the proxy's name against the project's media and proxies", async () => {
    const h = harness(["clip.proxy.mp4"]);
    expect((await h.run()).fileName).toBe("clip.proxy-1.mp4");
    expect(h.findMany.mock.calls[0][0]).toMatchObject({ where: { projectId: "project", kind: { in: ["media", "proxy"] } } });
  });

  test("a failed upload leaves no object behind", async () => {
    const h = harness();
    h.io.upload.mockImplementation(async () => { throw new Error("R2 down"); });
    await expect(h.run()).rejects.toThrow("R2 down");
    expect(h.io.unregister).toHaveBeenCalled();
    expect(h.io.remove.mock.calls[0][0]).toEqual(["cut/owner/projects/project/media/clip.proxy.mp4"]);
    expect(h.io.register).not.toHaveBeenCalled();
  });

  test("a cancel stops before the encode", async () => {
    const h = harness();
    await expect(h.run(() => true)).rejects.toThrow("canceled");
    expect(h.io.make).not.toHaveBeenCalled();
  });

  // A master ffmpeg refuses fails the same way on every try; a build killed
  // by a signal or lost to storage does not, and the row tells them apart.
  test("an encode that refuses the master records the file's fault; a killed one does not", async () => {
    const refused = harness();
    refused.io.make.mockImplementation(async (handle: unknown) => {
      (handle as RenderHandle).proc = { signalCode: null, exitCode: 1 } as never;
      throw new Error("ffmpeg exited with code 1.");
    });
    const err = await refused.run().catch((e: unknown) => e);
    expect(err instanceof InputFault).toBe(true);
    expect((err as InputFault).fault).toBe(PROXY_SOURCE_FAULT);

    const killed = harness();
    killed.io.make.mockImplementation(async (handle: unknown) => {
      (handle as RenderHandle).proc = { signalCode: "SIGKILL", exitCode: null } as never;
      throw new Error("Export stalled — no ffmpeg output for 120s.");
    });
    expect((await killed.run().catch((e: unknown) => e)) instanceof InputFault).toBe(false);
  });
});
