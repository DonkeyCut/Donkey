import { createAudioTranscribeJob, getTranscribeJob } from "../transcribe";

/** On-device speech for audio the caller supplies, rather than for a project
 * this engine stores: a cloud project renders its audible mix in the browser
 * and sends it here so transcription still runs on the Mac. Start a job, poll
 * it — the same shape as the project transcribe routes. */
export const sttApi = {
  async create(req: Request) {
    try {
      const form = await req.formData();
      const audio = form.get("audio");
      if (!(audio instanceof File)) {
        return Response.json({ error: "audio is required." }, { status: 400 });
      }
      const duration = Number(form.get("duration"));
      const locale = form.get("locale");
      const job = await createAudioTranscribeJob(new Uint8Array(await audio.arrayBuffer()), {
        locale: typeof locale === "string" && locale ? locale : undefined,
        duration: Number.isFinite(duration) ? duration : undefined,
      });
      if (job.status === "error") return Response.json({ error: job.error }, { status: 400 });
      return Response.json({ id: job.id });
    } catch (e) {
      return Response.json(
        { error: e instanceof Error ? e.message : "Transcription failed to start." },
        { status: 500 }
      );
    }
  },

  status(_req: Request, { jobId }: { jobId: string }) {
    const job = getTranscribeJob(jobId);
    if (!job) return Response.json({ error: "Unknown transcription job." }, { status: 404 });
    return Response.json({
      status: job.status,
      stage: job.stage,
      error: job.error,
      cues: job.cues,
    });
  },
};
