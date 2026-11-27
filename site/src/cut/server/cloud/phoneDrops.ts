// Upload from phone, the server half. A computer opens a drop for one place in
// the account and shows its code as a QR; a phone that scans it trades the code
// for a send pass and uploads straight to R2 staging on presigned part URLs.
// The computer that opened the drop takes each staged file into its place
// through the same import every Upload uses, then tells us to drop the bytes.
//
// Two lifetimes keep a send from failing halfway. The code is good only while
// the computer heartbeats it: closing the dialog stops new scans and new files.
// A file the phone started while the code was good stays sendable on its pass
// until the staging window closes, however long the phone takes.
import { createHash, randomBytes } from "node:crypto";
import { z } from "zod";

import { notFoundResponse, unauthorizedResponse } from "@/lib/donkey-api-auth";
import { prisma } from "@/lib/prisma";

import { getProject } from "./projects";
import {
  abortMultipart,
  completeMultipart,
  createMultipart,
  del,
  head,
  phoneStagingKey,
  phoneThumbKey,
  presignGet,
  presignPart,
  putObject,
} from "./r2";
import { quotaCheck } from "./usage";

/** How long a drop outlives its last heartbeat. The computer beats every few
 * seconds while the code is on screen; a laptop that sleeps loses its code. */
const ALIVE_WINDOW_MS = 30_000;
/** How long a staged file waits for its computer, and how long a started file
 * may keep sending after its drop closed. The sweep removes anything older. */
export const PHONE_STAGING_TTL_MS = 24 * 60 * 60 * 1000;
/** A claimed file whose computer went quiet goes back to waiting after this.
 * Long enough for a big file to download and import on a slow connection. */
const CLAIM_LAPSE_MS = 30 * 60 * 1000;
/** Part size the phone cuts files into. R2 wants at least 5 MiB for every part
 * but the last and allows 10,000 parts, so this carries files up to 80 GiB. */
export const PHONE_PART_BYTES = 8 * 1024 * 1024;
const MAX_PARTS = 10_000;
/** The largest single file a phone may send. */
const MAX_FILE_BYTES = 20 * 1024 * 1024 * 1024;
/** How many part URLs one request may ask for. */
const MAX_PART_URLS = 8;
/** The phone's thumbnail of a file, shown on the computer while it sends. */
const MAX_THUMB_BYTES = 256 * 1024;
/** The code's length in base-32 characters: 80 random bits. */
const CODE_LENGTH = 16;
/** Unambiguous upper-case base-32: no 0/O or 1/I/L, and never a "." (the
 * proxy skips any path with a dot in it). */
const CODE_ALPHABET = "23456789ABCDEFGHJKMNPQRSTUVWXYZ";
/** The send pass's random bytes. */
const PASS_BYTES = 24;

const HTTP_BAD_REQUEST = 400;
const HTTP_CONFLICT = 409;
const HTTP_GONE = 410;
const HTTP_PAYLOAD_TOO_LARGE = 413;

const sha256 = (value: string) => createHash("sha256").update(value).digest("hex");

/** A fresh code. Rejection sampling keeps every character equally likely. */
function newCode(): string {
  let out = "";
  while (out.length < CODE_LENGTH) {
    for (const byte of randomBytes(CODE_LENGTH)) {
      // 248 is the largest multiple of the alphabet's 31 characters under 256.
      if (byte < 248 && out.length < CODE_LENGTH) {
        out += CODE_ALPHABET[byte % CODE_ALPHABET.length];
      }
    }
  }
  return out;
}

/** The phone's kind, for the computer's list: "iPhone 4 of 9". Read from the
 * user agent's platform token, which is a technical field, never user text. */
function deviceOf(req: Request): string {
  const agent = req.headers.get("user-agent") ?? "";
  if (/iPhone/.test(agent)) {
    return "iPhone";
  }
  if (/iPad/.test(agent)) {
    return "iPad";
  }
  if (/Android/.test(agent)) {
    return "Android";
  }
  return "Phone";
}

// --- Shapes ---

const residencySchema = z.enum(["local", "cloud", "browser"]);

/** Where a drop's files go: a Library folder (or its top level) on one
 * residency, or one project's Project Files (or a folder in them). */
const targetSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("library"), residency: residencySchema, folderId: z.string().min(1).nullable() }),
  z.object({
    kind: z.literal("project"),
    residency: residencySchema,
    projectId: z.string().min(1),
    folderId: z.string().min(1).nullable(),
  }),
]);
export type PhoneTarget = z.infer<typeof targetSchema>;

const openSchema = z.object({
  clientId: z.string().min(8).max(64),
  target: targetSchema,
  label: z.string().min(1).max(200),
  single: z.boolean(),
});
const clientSchema = z.object({ clientId: z.string().min(8).max(64) });
const codeSchema = z.object({ code: z.string().length(CODE_LENGTH) });
const passSchema = z.object({ pass: z.string().min(16).max(64) });
const startSchema = passSchema.extend({
  name: z.string().min(1).max(255),
  mime: z.string().max(255),
  bytes: z.number().int().positive().max(MAX_FILE_BYTES),
});
const partsSchema = passSchema.extend({
  sent: z.number().int().nonnegative(),
  parts: z.array(z.number().int().min(1).max(MAX_PARTS)).max(MAX_PART_URLS),
});

/** The body parsed by `schema`, or null when it does not fit. */
async function bodyOf<T>(req: Request, schema: z.ZodType<T>): Promise<T | null> {
  const parsed = schema.safeParse(await req.json().catch(() => null));
  return parsed.success ? parsed.data : null;
}

const badRequest = () => Response.json({ error: "Bad request" }, { status: HTTP_BAD_REQUEST });

/** Whether the computer still holds the drop's code up. */
const isOpen = (drop: { closedAt: Date | null; aliveAt: Date }) =>
  drop.closedAt === null && drop.aliveAt.getTime() > Date.now() - ALIVE_WINDOW_MS;

/** Files are staged only for a while; past that the sweep owns them. */
const stagingCutoff = () => new Date(Date.now() - PHONE_STAGING_TTL_MS);

/** Whether a drop's files may land on the asking computer. A cloud place is
 * reachable from any of the account's computers; a Mac's or a browser's
 * storage only from the browser that opened the drop. */
const landsHere = (target: PhoneTarget, dropClientId: string, clientId: string) =>
  target.residency === "cloud" || dropClientId === clientId;

/** The drop behind a send pass, with the pass. */
async function passOf(token: string) {
  const pass = await prisma.cutPhonePass.findUnique({ where: { tokenHash: sha256(token) } });
  if (!pass) {
    return null;
  }
  const drop = await prisma.cutPhoneDrop.findUnique({ where: { id: pass.dropId } });
  return drop ? { pass, drop } : null;
}

/** A file the pass started, still inside the staging window. */
async function passFile(token: string, fileId: string) {
  const owner = await passOf(token);
  if (!owner) {
    return null;
  }
  const file = await prisma.cutPhoneFile.findFirst({
    where: { id: fileId, passId: owner.pass.id, createdAt: { gt: stagingCutoff() } },
  });
  return file ? { ...owner, file } : null;
}

// --- The computer's side (signed in) ---

export const phoneDropsOwner = {
  /** Open a drop for one place and hand back its code. */
  async open(userId: string, req: Request) {
    const body = await bodyOf(req, openSchema);
    if (!body) {
      return badRequest();
    }

    // A cloud project must be this account's; local and browser places live
    // on the asking computer and are checked there when files land.
    if (body.target.kind === "project" && body.target.residency === "cloud") {
      if (!(await getProject(userId, body.target.projectId))) {
        return notFoundResponse();
      }
    }

    const code = newCode();
    const drop = await prisma.cutPhoneDrop.create({
      data: {
        userId,
        codeHash: sha256(code),
        clientId: body.clientId,
        target: body.target,
        label: body.label,
        single: body.single,
      },
    });
    return Response.json({ id: drop.id, code });
  },

  /** The heartbeat that keeps the code good, answered with the drop's files
   * so the dialog can draw each one's progress. A drop whose heartbeat lapsed
   * (the laptop slept) answers closed, and the dialog opens a fresh one. */
  async alive(userId: string, dropId: string) {
    const drop = await prisma.cutPhoneDrop.findFirst({ where: { id: dropId, userId } });
    if (!drop) {
      return notFoundResponse();
    }
    const open = isOpen(drop);
    if (open) {
      await prisma.cutPhoneDrop.update({ where: { id: drop.id }, data: { aliveAt: new Date() } });
    }

    const [files, passes] = await Promise.all([
      prisma.cutPhoneFile.findMany({ where: { dropId }, orderBy: { createdAt: "asc" } }),
      prisma.cutPhonePass.findMany({ where: { dropId } }),
    ]);
    const deviceOfPass = new Map(passes.map((p) => [p.id, p.device]));
    return Response.json({
      open,
      phones: passes.length,
      files: await Promise.all(
        files.map(async (f) => ({
          id: f.id,
          name: f.name,
          mime: f.mime,
          bytes: Number(f.bytes),
          sentBytes: Number(f.sentBytes),
          state: f.state,
          device: deviceOfPass.get(f.passId) ?? "Phone",
          thumbUrl: f.thumbKey ? await presignGet(f.thumbKey) : null,
        }))
      ),
    });
  },

  /** Retire the code: no new scans, no new files. Files already sending go on. */
  async close(userId: string, dropId: string) {
    await prisma.cutPhoneDrop.updateMany({ where: { id: dropId, userId, closedAt: null }, data: { closedAt: new Date() } });
    return Response.json({ ok: true });
  },

  /** What this computer can take in now, and the files still on their way
   * to it: the page draws a tile for each and keeps looking while any are. */
  async inbox(userId: string, req: Request) {
    const body = await bodyOf(req, clientSchema);
    if (!body) {
      return badRequest();
    }

    const drops = await prisma.cutPhoneDrop.findMany({ where: { userId, aliveAt: { gt: stagingCutoff() } } });
    const mine = new Map<string, PhoneTarget>();
    for (const drop of drops) {
      const target = targetSchema.safeParse(drop.target);
      if (target.success && landsHere(target.data, drop.clientId, body.clientId)) {
        mine.set(drop.id, target.data);
      }
    }
    if (mine.size === 0) {
      return Response.json({ files: [], sending: [] });
    }

    const lapsed = new Date(Date.now() - CLAIM_LAPSE_MS);
    const [ready, sending] = await Promise.all([
      prisma.cutPhoneFile.findMany({
        where: {
          dropId: { in: [...mine.keys()] },
          OR: [{ state: "staged" }, { state: "claimed", claimedAt: { lt: lapsed } }],
        },
        orderBy: { createdAt: "asc" },
      }),
      prisma.cutPhoneFile.findMany({
        where: { dropId: { in: [...mine.keys()] }, state: "sending" },
        orderBy: { createdAt: "asc" },
      }),
    ]);
    return Response.json({
      sending: sending.map((f) => ({ id: f.id, dropId: f.dropId, name: f.name, mime: f.mime, target: mine.get(f.dropId) })),
      files: ready.map((f) => ({
        id: f.id,
        dropId: f.dropId,
        name: f.name,
        mime: f.mime,
        bytes: Number(f.bytes),
        target: mine.get(f.dropId),
      })),
    });
  },

  /** Take one staged file for this computer. Exactly one caller wins: the
   * claim is a guarded update, and the loser sees a 409. The winner gets a
   * read URL for the bytes. */
  async claim(userId: string, fileId: string) {
    const lapsed = new Date(Date.now() - CLAIM_LAPSE_MS);
    const claimed = await prisma.cutPhoneFile.updateMany({
      where: {
        id: fileId,
        userId,
        OR: [{ state: "staged" }, { state: "claimed", claimedAt: { lt: lapsed } }],
      },
      data: { state: "claimed", claimedAt: new Date() },
    });
    if (claimed.count !== 1) {
      return Response.json({ error: "Already taken" }, { status: HTTP_CONFLICT });
    }
    const file = await prisma.cutPhoneFile.findUniqueOrThrow({ where: { id: fileId } });
    return Response.json({ url: await presignGet(file.r2Key) });
  },

  /** Put a claimed file back for another pass. */
  async release(userId: string, fileId: string) {
    await prisma.cutPhoneFile.updateMany({ where: { id: fileId, userId, state: "claimed" }, data: { state: "staged", claimedAt: null } });
    return Response.json({ ok: true });
  },

  /** The file is in its place: the staged bytes go. The thumbnail stays with
   * the row for the open dialog and leaves with it in the sweep. */
  async landed(userId: string, fileId: string) {
    return settle(userId, fileId, "landed");
  },

  /** The file could not be taken in. Its bytes go; the computer shows why. */
  async failed(userId: string, fileId: string) {
    return settle(userId, fileId, "failed");
  },
};

async function settle(userId: string, fileId: string, state: "landed" | "failed") {
  const file = await prisma.cutPhoneFile.findFirst({ where: { id: fileId, userId, state: "claimed" } });
  if (!file) {
    return notFoundResponse();
  }
  await prisma.cutPhoneFile.update({ where: { id: file.id }, data: { state } });
  await del([file.r2Key]);
  return Response.json({ ok: true });
}

// --- The phone's side (no session; the code and the pass are the keys) ---

export const phoneDropsPublic = {
  /** Trade a live code for a send pass. */
  async open(req: Request) {
    const body = await bodyOf(req, codeSchema);
    if (!body) {
      return badRequest();
    }
    const drop = await prisma.cutPhoneDrop.findUnique({ where: { codeHash: sha256(body.code.toUpperCase()) } });
    if (!drop || !isOpen(drop)) {
      return Response.json({ error: "expired" }, { status: HTTP_GONE });
    }

    const pass = randomBytes(PASS_BYTES).toString("base64url");
    await prisma.cutPhonePass.create({ data: { dropId: drop.id, tokenHash: sha256(pass), device: deviceOf(req) } });
    return Response.json({ pass, label: drop.label, single: drop.single, partBytes: PHONE_PART_BYTES });
  },

  /** Start one file: only while the code is good. */
  async start(req: Request) {
    const body = await bodyOf(req, startSchema);
    if (!body) {
      return badRequest();
    }
    const owner = await passOf(body.pass);
    if (!owner) {
      return unauthorizedResponse();
    }
    const { pass, drop } = owner;
    if (!isOpen(drop)) {
      return Response.json({ error: "expired" }, { status: HTTP_GONE });
    }
    if (Math.ceil(body.bytes / PHONE_PART_BYTES) > MAX_PARTS) {
      return Response.json({ error: "too_large" }, { status: HTTP_PAYLOAD_TOO_LARGE });
    }

    // Replace takes one file.
    if (drop.single && (await prisma.cutPhoneFile.count({ where: { dropId: drop.id, state: { not: "failed" } } })) > 0) {
      return Response.json({ error: "one_file" }, { status: HTTP_CONFLICT });
    }

    // A cloud place says now when it has no room, so the phone does not send
    // a file the import will refuse. Staged bytes themselves never count.
    const target = targetSchema.parse(drop.target);
    if (target.residency === "cloud") {
      const full = await quotaCheck(drop.userId, body.bytes);
      if (full) {
        return full;
      }
    }

    const id = randomBytes(12).toString("base64url");
    const key = phoneStagingKey(drop.userId, drop.id, id);
    const mime = body.mime || "application/octet-stream";
    const uploadId = await createMultipart(key, mime);
    await prisma.cutPhoneFile.create({
      data: {
        id,
        dropId: drop.id,
        passId: pass.id,
        userId: drop.userId,
        name: body.name,
        mime,
        bytes: BigInt(body.bytes),
        r2Key: key,
        uploadId,
      },
    });
    return Response.json({ fileId: id, partBytes: PHONE_PART_BYTES });
  },

  /** URLs for the next parts, and the phone's count of bytes sent so far for
   * the computer's progress bar. Good after the drop closed: the pass carries
   * the file to the end. */
  async parts(req: Request, fileId: string) {
    const body = await bodyOf(req, partsSchema);
    if (!body) {
      return badRequest();
    }
    const owned = await passFile(body.pass, fileId);
    if (!owned || owned.file.state !== "sending") {
      return notFoundResponse();
    }
    const { file } = owned;

    await prisma.cutPhoneFile.update({
      where: { id: file.id },
      data: { sentBytes: BigInt(Math.min(body.sent, Number(file.bytes))) },
    });
    const urls: Record<number, string> = {};
    for (const n of body.parts) {
      urls[n] = await presignPart(file.r2Key, file.uploadId, n);
    }
    return Response.json({ urls });
  },

  /** The phone's small picture of the file. The pass rides a header because
   * the body is the JPEG. */
  async thumb(req: Request, fileId: string) {
    const token = req.headers.get("x-phone-pass") ?? "";
    const owned = await passFile(token, fileId);
    if (!owned) {
      return notFoundResponse();
    }
    const bytes = Buffer.from(await req.arrayBuffer());
    if (bytes.length === 0 || bytes.length > MAX_THUMB_BYTES) {
      return badRequest();
    }
    const key = phoneThumbKey(owned.drop.userId, owned.drop.id, fileId);
    await putObject(key, bytes, "image/jpeg");
    await prisma.cutPhoneFile.update({ where: { id: fileId }, data: { thumbKey: key } });
    return Response.json({ ok: true });
  },

  /** Join the parts. The file is staged once R2 holds every byte the phone
   * said it would send. */
  async complete(req: Request, fileId: string) {
    const body = await bodyOf(req, passSchema);
    if (!body) {
      return badRequest();
    }
    const owned = await passFile(body.pass, fileId);
    if (!owned) {
      return notFoundResponse();
    }
    const { file } = owned;

    // A retried completion after the first one landed answers the same.
    if (file.state !== "sending") {
      return Response.json({ ok: true });
    }
    await completeMultipart(file.r2Key, file.uploadId);
    const stored = await head(file.r2Key);
    if (!stored || stored.bytes !== Number(file.bytes)) {
      return badRequest();
    }
    await prisma.cutPhoneFile.update({ where: { id: file.id }, data: { state: "staged", sentBytes: file.bytes } });
    return Response.json({ ok: true });
  },

  /** The phone stopped this file. */
  async abort(req: Request, fileId: string) {
    const body = await bodyOf(req, passSchema);
    if (!body) {
      return badRequest();
    }
    const owned = await passFile(body.pass, fileId);
    if (!owned || owned.file.state !== "sending") {
      return notFoundResponse();
    }
    const { file } = owned;
    await abortMultipart(file.r2Key, file.uploadId);
    await prisma.cutPhoneFile.update({ where: { id: file.id }, data: { state: "failed" } });
    await del(file.thumbKey ? [file.thumbKey] : []);
    return Response.json({ ok: true });
  },
};

/** The sweep: every drop whose computer last held its code up more than the
 * staging window ago goes with its passes and its files, unfinished uploads
 * aborted and staged bytes deleted. */
export async function sweepPhoneDrops(): Promise<number> {
  const cutoff = stagingCutoff();
  const drops = await prisma.cutPhoneDrop.findMany({ where: { aliveAt: { lt: cutoff } }, select: { id: true } });
  if (drops.length === 0) {
    return 0;
  }
  const dropIds = drops.map((d) => d.id);
  const files = await prisma.cutPhoneFile.findMany({ where: { dropId: { in: dropIds } } });

  for (const f of files.filter((f) => f.state === "sending")) {
    await abortMultipart(f.r2Key, f.uploadId);
  }
  await del(files.flatMap((f) => [f.r2Key, ...(f.thumbKey ? [f.thumbKey] : [])]));
  await prisma.$transaction([
    prisma.cutPhoneFile.deleteMany({ where: { dropId: { in: dropIds } } }),
    prisma.cutPhonePass.deleteMany({ where: { dropId: { in: dropIds } } }),
    prisma.cutPhoneDrop.deleteMany({ where: { id: { in: dropIds } } }),
  ]);
  return files.length;
}
