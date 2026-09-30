import { describe, expect, mock, test } from "bun:test";
import { writeFile } from "node:fs/promises";
import type { prisma } from "@/lib/prisma";
import { runProxyJob, type ProxyJobIO } from "./proxyJob";

function harness(taken: string[] = []) {
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
    settings: mock(async () => ({ proxyMaxHeight: 1080, proxyCrf: 20 })),
  } satisfies ProxyJobIO;
  const job = { id: "proxy-1", userId: "owner", projectId: "project", kind: "proxy", outName: null, spec: { file: "clip.mov" } };
  const handle = { tmpDir: "", outPath: "", progress: 0, log: [] as string[] };
  const run = (canceled = () => false) => runProxyJob(job, handle, canceled, io);
  return { run, io, handle, findMany };
}

describe("proxy worker", () => {
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
});
