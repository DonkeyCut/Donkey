import {
  addPhoneClip,
  claimPhoneClip,
  claimPhonePairing,
  closePhonePairing,
  listPhoneClips,
  listPhoneDevices,
  movePhoneClipToProject,
  openPhonePairing,
  phoneClipPath,
  phoneDeviceForToken,
  phonePairingClose,
  phonePairingWindow,
  releasePhoneClip,
  removePhoneClip,
  removePhoneDevice,
} from "../phoneLink";
import { serveFileRange } from "../serveFile";

const err = (message: string, status: number) => Response.json({ error: message }, { status });
const caught = (e: unknown, fallback: string) =>
  err(e instanceof Error ? e.message : fallback, 500);

/** The header a paired phone's traffic carries. The app's listener copies it
 * across from the peer connection; nothing else on this Mac sets it. */
const TOKEN_HEADER = "x-donkey-phone-token";

/** The app names the file it already staged on this Mac's disk, and the engine
 * moves it into the inbox instead of taking a second copy through loopback. */
const STAGED_HEADER = "x-donkey-phone-file";

/**
 * The phone link's API: pairing, the paired devices, and the inbox of clips
 * waiting for an editor.
 *
 * Two callers, both on loopback. The settings page mints and revokes, and reads
 * the device list. The app's peer listener checks a phone's token before it
 * writes a byte, claims a pairing code on a phone's behalf, and hands over the
 * clips it has staged.
 */
export const phoneLinkApi = {
  /** The devices paired with this Mac, the pairing code if one is open, and how
   * the last window ended when one is not. */
  async status() {
    try {
      return Response.json({
        devices: await listPhoneDevices(),
        pairing: phonePairingWindow(),
        closed: phonePairingClose(),
      });
    } catch (e) {
      return caught(e, "Could not read the phone link.");
    }
  },

  /** Open a pairing window and answer with the code to show. */
  pair() {
    try {
      return Response.json(openPhonePairing());
    } catch (e) {
      return caught(e, "Could not start pairing.");
    }
  },

  /** Close an open window without pairing anything — the dialog was dismissed. */
  cancelPairing() {
    closePhonePairing();
    return Response.json({ ok: true });
  },

  /** A phone answering the code, relayed by the app's listener. The token in
   * the reply is the only time it exists outside the phone. */
  async claim(req: Request) {
    try {
      const { code, deviceName } = (await req.json()) as {
        code?: string;
        deviceName?: string;
      };
      const paired = await claimPhonePairing(code ?? "", deviceName ?? "");
      if (!paired) return err("That code is not open.", 403);
      return Response.json(paired);
    } catch (e) {
      return caught(e, "Could not pair that phone.");
    }
  },

  /** Is this phone still paired? The listener asks before it writes a clip to
   * disk: the bytes come off an open radio, and an unpaired sender must not be
   * able to spend this Mac's storage on the way to being refused. */
  async verify(req: Request) {
    try {
      const device = await phoneDeviceForToken(req.headers.get(TOKEN_HEADER) ?? "");
      if (!device) return err("This phone is not paired with this Mac.", 401);
      return Response.json({ device });
    } catch (e) {
      return caught(e, "Could not check that phone.");
    }
  },

  async devices() {
    try {
      return Response.json({ devices: await listPhoneDevices() });
    } catch (e) {
      return caught(e, "Could not read the paired phones.");
    }
  },

  /** Unpair: the phone's token stops working on its next upload. */
  async removeDevice(_req: Request, { id }: { id: string }) {
    try {
      await removePhoneDevice(decodeURIComponent(id));
      return Response.json({ ok: true });
    } catch (e) {
      return caught(e, "Could not unpair that phone.");
    }
  },

  /** A clip off a paired phone. The app has already staged the bytes on this
   * Mac, so this call is metadata and a path; the engine moves the file in. */
  async receive(req: Request) {
    try {
      const device = await phoneDeviceForToken(req.headers.get(TOKEN_HEADER) ?? "");
      if (!device) return err("This phone is not paired with this Mac.", 401);
      const staged = req.headers.get(STAGED_HEADER);
      if (!staged) return err("No staged clip named.", 400);
      const q = new URL(req.url).searchParams;
      const takeId = q.get("takeId");
      if (!takeId) return err("A clip carries the take it came from.", 400);
      const num = (key: string) => {
        const n = Number(q.get(key));
        return Number.isFinite(n) && n > 0 ? n : undefined;
      };
      const clip = await addPhoneClip(device, staged, {
        takeId,
        fileName: q.get("fileName") ?? "clip.mov",
        capturedAt: num("capturedAt"),
        durationSeconds: num("durationSeconds"),
        width: num("width"),
        height: num("height"),
      });
      return Response.json(clip);
    } catch (e) {
      return caught(e, "Could not take that clip.");
    }
  },

  /** What is waiting and unclaimed. The editor polls this while a phone is
   * paired. */
  async inbox() {
    try {
      return Response.json({ clips: await listPhoneClips() });
    } catch (e) {
      return caught(e, "Could not read the phone inbox.");
    }
  },

  /** Take a clip. Exactly one editor gets it; a second asking is told it is
   * already spoken for rather than handed a copy of its own. */
  async claimClip(_req: Request, { id }: { id: string }) {
    try {
      const clip = await claimPhoneClip(decodeURIComponent(id));
      if (!clip) return err("That clip is already taken.", 409);
      return Response.json(clip);
    } catch (e) {
      return caught(e, "Could not take that clip.");
    }
  },

  /** Give a claimed clip back, so the next pass finds it waiting. */
  async releaseClip(_req: Request, { id }: { id: string }) {
    try {
      await releasePhoneClip(decodeURIComponent(id));
      return Response.json({ ok: true });
    } catch (e) {
      return caught(e, "Could not put that clip back.");
    }
  },

  /** Move a claimed clip into a project on this Mac. Both ends are local disk,
   * so the bytes never go through the page. */
  async intoProject(req: Request, { id }: { id: string }) {
    try {
      const { projectId } = (await req.json()) as { projectId?: string };
      if (!projectId) return err("No project named.", 400);
      const fileName = await movePhoneClipToProject(decodeURIComponent(id), projectId);
      return Response.json({ fileName });
    } catch (e) {
      return caught(e, "Could not move that clip into the project.");
    }
  },

  /** The bytes, ranged — the editor reads them straight into its own store. */
  async clipFile(req: Request, { id }: { id: string }) {
    try {
      const file = await phoneClipPath(decodeURIComponent(id));
      if (!file) return err("That clip is gone.", 404);
      return serveFileRange(file, req);
    } catch (e) {
      return caught(e, "Could not read that clip.");
    }
  },

  /** Claimed, or thrown away. Either way the inbox lets it go. */
  async removeClip(_req: Request, { id }: { id: string }) {
    try {
      await removePhoneClip(decodeURIComponent(id));
      return Response.json({ ok: true });
    } catch (e) {
      return caught(e, "Could not clear that clip.");
    }
  },
};
