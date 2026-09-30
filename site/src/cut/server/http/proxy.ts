import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { makeProxy, proxyNameFor } from "../proxy";

/**
 * Build a preview proxy of a master the caller supplies, for a project this
 * engine does not store. A browser project's ProRes file lives in the page,
 * and a browser with no 10-bit encoder has nothing to build the proxy with —
 * so the bytes come here, the Mac's ffmpeg encodes them, and the proxy goes
 * back to the page that owns the project. Nothing is kept: the temp
 * directory goes with the response.
 */
export const proxyApi = {
  async create(req: Request) {
    const tmp = await mkdtemp(path.join(os.tmpdir(), "cut-proxy-"));
    try {
      const form = await req.formData();
      const file = form.get("file");
      if (!(file instanceof File)) {
        return Response.json({ error: "file is required." }, { status: 400 });
      }
      const maxHeight = Number(form.get("maxHeight"));
      const crf = Number(form.get("crf"));
      if (!Number.isFinite(maxHeight) || !Number.isFinite(crf)) {
        return Response.json({ error: "maxHeight and crf are required." }, { status: 400 });
      }
      const name = path.basename(file.name) || "source";
      const src = path.join(tmp, name);
      const out = path.join(tmp, proxyNameFor(name));
      await writeFile(src, new Uint8Array(await file.arrayBuffer()));
      const handle = { tmpDir: tmp, outPath: out, progress: 0, log: [] as string[] };
      await makeProxy(handle, src, out, { maxHeight, crf });
      const bytes = await readFile(out);
      return new Response(new Uint8Array(bytes), {
        headers: { "Content-Type": "video/mp4", "Content-Length": String(bytes.length) },
      });
    } catch (e) {
      return Response.json(
        { error: e instanceof Error ? e.message : "Could not make the preview proxy." },
        { status: 500 }
      );
    } finally {
      void rm(tmp, { recursive: true, force: true });
    }
  },
};
