import { cancelMic, feedMic, getMicJob, startMicJob, stopMic } from "../mic";
import { errorMessage } from "../util";

const err = (message: string, status: number) => Response.json({ error: message }, { status });

/** Live mic dictation: start a job, stream PCM to it, poll the transcript. */
export const micApi = {
  async start(req: Request) {
    try {
      const body = (await req.json().catch(() => ({}))) as { locale?: string };
      const job = await startMicJob(typeof body.locale === "string" ? body.locale : "en-US");
      return Response.json({ id: job.id });
    } catch (e) {
      return err(errorMessage(e, "Could not start dictation."), 500);
    }
  },

  async feed(req: Request, { id }: { id: string }) {
    const pcm = Buffer.from(await req.arrayBuffer());
    return feedMic(id, pcm) ? new Response(null, { status: 204 }) : err("Dictation is not running.", 409);
  },

  poll(_req: Request, { id }: { id: string }) {
    const job = getMicJob(id);
    if (!job) return err("Unknown dictation.", 404);
    return Response.json({ status: job.status, text: job.text, error: job.error });
  },

  async stop(_req: Request, { id }: { id: string }) {
    const text = await stopMic(id);
    if (text === null) return err("Unknown dictation.", 404);
    return Response.json({ text });
  },

  cancel(_req: Request, { id }: { id: string }) {
    return cancelMic(id) ? new Response(null, { status: 204 }) : err("Unknown dictation.", 404);
  },
};
