import {
  cancelJob,
  completeClientJob,
  createClientJob,
  createJob,
  getJob,
  listAllJobs,
  progressClientJob,
  releaseClientJob,
  type ExportSpec,
} from "../jobs";
import { serveFileRange } from "../serveFile";

/** Export rendering: start a job, poll it, cancel it, download the result. */
export const exportApi = {
  /** Every export job across every project, in start order — the feed the
   * app-wide exports dock polls so it shows the same queue in every tab. */
  activeAll() {
    return Response.json(listAllJobs());
  },

  async create(req: Request) {
    try {
      const form = await req.formData();
      const job = await createJob(form);
      if (job.status === "error") {
        return Response.json({ error: job.error }, { status: 400 });
      }
      return Response.json({ id: job.id });
    } catch (e) {
      return Response.json(
        { error: e instanceof Error ? e.message : "Export failed to start." },
        { status: 500 }
      );
    }
  },

  /** A render the browser tab carries itself: open the job row and claim the
   * file's name; the tab draws the frames and hands the file in below. */
  async createClient(req: Request) {
    try {
      const body = (await req.json()) as { projectId?: string; container?: ExportSpec["container"] };
      if (!body.projectId) return Response.json({ error: "Missing project." }, { status: 400 });
      const job = await createClientJob(body.projectId, body.container);
      if (job.status === "error") return Response.json({ error: job.error }, { status: 400 });
      return Response.json({ id: job.id, outName: job.outName });
    } catch (e) {
      return Response.json(
        { error: e instanceof Error ? e.message : "Export failed to start." },
        { status: 500 }
      );
    }
  },

  async clientProgress(req: Request, { jobId }: { jobId: string }) {
    const body = (await req.json().catch(() => ({}))) as { ratio?: number };
    progressClientJob(jobId, Number(body.ratio));
    return Response.json({ ok: true });
  },

  /** The finished file, streamed straight into the project's exports folder. */
  async clientComplete(req: Request, { jobId }: { jobId: string }) {
    const job = await completeClientJob(jobId, req.body);
    if (!job) return Response.json({ error: "This export is no longer running." }, { status: 409 });
    if (job.status === "error") return Response.json({ error: job.error }, { status: 500 });
    return Response.json({ id: job.id, outName: job.outName });
  },

  async clientRelease(_req: Request, { jobId }: { jobId: string }) {
    releaseClientJob(jobId);
    return Response.json({ ok: true });
  },

  async status(_req: Request, { jobId }: { jobId: string }) {
    const job = getJob(jobId);
    if (!job) return Response.json({ error: "Unknown export." }, { status: 404 });
    return Response.json({
      status: job.status,
      progress: job.progress,
      error: job.error,
      outName: job.outName,
    });
  },

  async cancel(_req: Request, { jobId }: { jobId: string }) {
    cancelJob(jobId);
    return Response.json({ ok: true });
  },

  async file(req: Request, { jobId }: { jobId: string }) {
    const job = getJob(jobId);
    if (!job || job.status !== "done") {
      return new Response("Export not ready.", { status: 404 });
    }
    return serveFileRange(job.outPath, req, { downloadName: job.outName });
  },
};
