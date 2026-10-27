import { cancelMic, feedMic, getMicJob, startMicJob, stopMic } from "../mic";
import { UserError } from "../../lib/userError";
import { errorReply } from "../util";

const err = (failure: string | UserError, status: number) => Response.json(errorReply(failure, ""), { status });

const dictationUnknown = () => new UserError("dictation_unknown", "Unknown dictation.");

/** Live mic dictation: start a job, stream PCM to it, poll the transcript. */
export const micApi = {
  async start(req: Request) {
    try {
      const body = (await req.json().catch(() => ({}))) as { locale?: string };
      const job = await startMicJob(typeof body.locale === "string" ? body.locale : "en-US");
      return Response.json({ id: job.id });
    } catch (e) {
      return Response.json(errorReply(e, new UserError("dictation_start_failed", "Could not start dictation.")), { status: 500 });
    }
  },

  async feed(req: Request, { id }: { id: string }) {
    const pcm = Buffer.from(await req.arrayBuffer());
    return feedMic(id, pcm) ? new Response(null, { status: 204 }) : err(new UserError("dictation_not_running", "Dictation is not running."), 409);
  },

  poll(_req: Request, { id }: { id: string }) {
    const job = getMicJob(id);
    if (!job) return err(dictationUnknown(), 404);
    return Response.json({ status: job.status, text: job.text, error: job.error, errorCode: job.errorCode, errorParams: job.errorParams });
  },

  async stop(_req: Request, { id }: { id: string }) {
    const text = await stopMic(id);
    if (text === null) return err(dictationUnknown(), 404);
    return Response.json({ text });
  },

  cancel(_req: Request, { id }: { id: string }) {
    return cancelMic(id) ? new Response(null, { status: 204 }) : err(dictationUnknown(), 404);
  },
};
