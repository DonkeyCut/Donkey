import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { convertToMp4, mp4NameFor } from "../convert";

/**
 * Convert media the caller supplies, for a project this engine does not store.
 * A browser project's files live in the page, and a browser without a decoder
 * for them has nothing to convert with — so the bytes come here, the Mac's
 * ffmpeg rewrites them, and the MP4 goes back to the page that owns them.
 * Nothing is kept: the temp directory goes with the response.
 */
export const convertApi = {
  async create(req: Request) {
    const tmp = await mkdtemp(path.join(os.tmpdir(), "cut-convert-"));
    try {
      const form = await req.formData();
      const file = form.get("file");
      if (!(file instanceof File)) {
        return Response.json({ error: "file is required." }, { status: 400 });
      }
      const maxHeight = Number(form.get("maxHeight"));
      const src = path.join(tmp, path.basename(file.name) || "source");
      const out = path.join(tmp, mp4NameFor(path.basename(file.name) || "media"));
      await writeFile(src, new Uint8Array(await file.arrayBuffer()));
      const handle = { tmpDir: tmp, outPath: out, progress: 0, log: [] as string[] };
      await convertToMp4(handle, src, out, {
        maxHeight: Number.isFinite(maxHeight) && maxHeight > 0 ? maxHeight : undefined,
      });
      const bytes = await readFile(out);
      return new Response(new Uint8Array(bytes), {
        headers: { "Content-Type": "video/mp4", "Content-Length": String(bytes.length) },
      });
    } catch (e) {
      return Response.json(
        { error: e instanceof Error ? e.message : "Could not convert that file." },
        { status: 500 }
      );
    } finally {
      void rm(tmp, { recursive: true, force: true });
    }
  },
};
