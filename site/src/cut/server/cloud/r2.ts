// Cloudflare R2 access for Cut web mode. Media bytes live here; metadata rows
// (CutMediaObject) record the keys. Only credentials come from env — bucket
// name, key scheme, and expiries are code.
import {
  CopyObjectCommand,
  DeleteObjectsCommand,
  GetObjectCommand,
  HeadObjectCommand,
  PutObjectCommand,
  S3Client,
} from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";

const R2_BUCKET = "donkey-cut";

const PUT_EXPIRY_SECONDS = 60 * 60; // 1h — the client uploads right after presigning
// 24h from the signing window's start (see signingWindowStart) — hydrated
// asset URLs live a session. Clients should refresh against
// presignGetLifetime(), which subtracts the elapsed part of the window.
export const GET_EXPIRY_SECONDS = 24 * 60 * 60;

export class R2NotConfiguredError extends Error {
  constructor() {
    super("cloud storage is not configured");
  }
}

let client: S3Client | null = null;

function r2(): S3Client {
  if (client) return client;
  const accountId = process.env.R2_ACCOUNT_ID;
  const accessKeyId = process.env.R2_ACCESS_KEY_ID;
  const secretAccessKey = process.env.R2_SECRET_ACCESS_KEY;
  if (!accountId || !accessKeyId || !secretAccessKey) throw new R2NotConfiguredError();
  client = new S3Client({
    region: "auto",
    endpoint: `https://${accountId}.r2.cloudflarestorage.com`,
    credentials: { accessKeyId, secretAccessKey },
  });
  return client;
}

// --- Key scheme: everything a user owns lives under cut/<userId>/. ---

export const projectMediaKey = (userId: string, projectId: string, fileName: string) =>
  `cut/${userId}/projects/${projectId}/media/${fileName}`;
export const projectExportKey = (userId: string, projectId: string, fileName: string) =>
  `cut/${userId}/projects/${projectId}/exports/${fileName}`;
export const projectPreviewKey = (userId: string, projectId: string) =>
  `cut/${userId}/projects/${projectId}/preview.mp4`;
export const libraryKey = (userId: string, fileName: string) =>
  `cut/${userId}/library/${fileName}`;
export const overlayKey = (userId: string, batchId: string, name: string) =>
  `cut/${userId}/overlays/${batchId}/${name}`;

export function presignPut(key: string, mime: string): Promise<string> {
  return getSignedUrl(
    r2(),
    new PutObjectCommand({ Bucket: R2_BUCKET, Key: key, ContentType: mime }),
    { expiresIn: PUT_EXPIRY_SECONDS }
  );
}

/** Signatures are minted on window boundaries rather than at the current
 * instant, so the same object presigns to the same URL for everyone asking
 * within the window. A signature that changed per request made every media
 * URL unique, which meant the browser cache (and any cache in front of it)
 * could never reuse a byte — worst on a shared link, where many viewers pull
 * the same objects and one viewer re-pulls them on every reload. */
const SIGNING_WINDOW_SECONDS = 60 * 60; // 1h

/** Start of the signing window `at` falls in. Exported for the callers that
 * need to tell a client how long a URL stays good. */
export function signingWindowStart(at: number = Date.now()): Date {
  const ms = SIGNING_WINDOW_SECONDS * 1000;
  return new Date(Math.floor(at / ms) * ms);
}

/** Seconds a URL minted now is still valid for: the tail of its window plus
 * the expiry. Shorter than GET_EXPIRY_SECONDS, and it is what clients should
 * refresh against. */
export function presignGetLifetime(at: number = Date.now()): number {
  const elapsed = (at - signingWindowStart(at).getTime()) / 1000;
  return Math.round(GET_EXPIRY_SECONDS - elapsed);
}

export function presignGet(key: string, downloadName?: string): Promise<string> {
  return getSignedUrl(
    r2(),
    new GetObjectCommand({
      Bucket: R2_BUCKET,
      Key: key,
      ...(downloadName
        ? { ResponseContentDisposition: `attachment; filename="${downloadName.replace(/"/g, "")}"` }
        : {}),
    }),
    { expiresIn: GET_EXPIRY_SECONDS, signingDate: signingWindowStart() }
  );
}

/** Object size/type, or null when the object does not exist. */
export async function head(key: string): Promise<{ bytes: number; mime: string } | null> {
  try {
    const res = await r2().send(new HeadObjectCommand({ Bucket: R2_BUCKET, Key: key }));
    return { bytes: Number(res.ContentLength ?? 0), mime: res.ContentType ?? "" };
  } catch (e) {
    if (e instanceof R2NotConfiguredError) throw e;
    return null;
  }
}

export async function copy(srcKey: string, dstKey: string): Promise<void> {
  await r2().send(
    new CopyObjectCommand({
      Bucket: R2_BUCKET,
      CopySource: `${R2_BUCKET}/${encodeURIComponent(srcKey).replace(/%2F/g, "/")}`,
      Key: dstKey,
    })
  );
}

export async function putObject(key: string, body: Buffer, mime: string): Promise<void> {
  await r2().send(
    new PutObjectCommand({ Bucket: R2_BUCKET, Key: key, Body: body, ContentType: mime })
  );
}

/** Best-effort bulk delete — object cleanup never fails a row delete. */
export async function del(keys: string[]): Promise<void> {
  if (keys.length === 0) return;
  try {
    const s3 = r2();
    for (let i = 0; i < keys.length; i += 1000) {
      await s3.send(
        new DeleteObjectsCommand({
          Bucket: R2_BUCKET,
          Delete: { Objects: keys.slice(i, i + 1000).map((Key) => ({ Key })), Quiet: true },
        })
      );
    }
  } catch {
    // Orphaned objects are collectible later by key prefix; the rows are gone.
  }
}
