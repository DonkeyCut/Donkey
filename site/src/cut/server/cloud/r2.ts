// Cloudflare R2 access for Cut web mode. Media bytes live here; metadata rows
// (CutMediaObject) record the keys. Only credentials come from env — bucket
// name, key scheme, and expiries are code.
import {
  AbortMultipartUploadCommand,
  CompleteMultipartUploadCommand,
  CopyObjectCommand,
  CreateMultipartUploadCommand,
  DeleteObjectsCommand,
  GetObjectCommand,
  HeadObjectCommand,
  ListObjectsV2Command,
  ListPartsCommand,
  PutObjectCommand,
  S3Client,
  UploadPartCommand,
  type CompletedPart,
} from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";

const R2_BUCKET = "donkey-cut";

const PUT_EXPIRY_SECONDS = 60 * 60; // 1h — the client uploads right after presigning

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

/** Everything a project owns in the bucket — media, exports, the hover proxy,
 * the card, every ladder — lives under this one prefix, so a project delete
 * can sweep it whole. */
export const projectPrefix = (userId: string, projectId: string) =>
  `cut/${userId}/projects/${projectId}/`;
export const projectMediaKey = (userId: string, projectId: string, fileName: string) =>
  `${projectPrefix(userId, projectId)}media/${fileName}`;
export const projectExportKey = (userId: string, projectId: string, fileName: string) =>
  `cut/${userId}/projects/${projectId}/exports/${fileName}`;
export const projectPreviewKey = (userId: string, projectId: string) =>
  `cut/${userId}/projects/${projectId}/preview.mp4`;
/** Root of one HLS ladder. The doc version is a path segment rather than a
 * query parameter because a player reaches segments by relative URI: a version
 * that lived in the query would be dropped on the first hop out of a playlist,
 * and a re-rendered ladder would then be served the previous cut's segments out
 * of the edge cache. A new version is a new tree, and the old one is swept. */
export const projectHlsPrefix = (userId: string, projectId: string, version: string) =>
  `cut/${userId}/projects/${projectId}/hls/${version}`;
export const projectHlsRoot = (userId: string, projectId: string) =>
  `cut/${userId}/projects/${projectId}/hls/`;
/** The link-preview card's artifacts. Fixed keys, rewritten by each card
 * render: the public URL carries the doc version, so freshness rides the URL
 * and R2 keeps one copy instead of one per edit. */
export const projectCardKey = (userId: string, projectId: string, ext: "jpg" | "gif") =>
  `cut/${userId}/projects/${projectId}/card.${ext}`;
export const libraryKey = (userId: string, fileName: string) =>
  `cut/${userId}/library/${fileName}`;
/** A shared library video's link-preview still: its first frame, one per asset. */
export const libraryCardKey = (userId: string, assetId: string) =>
  `cut/${userId}/library-cards/${assetId}.jpg`;
/** Per-user root of the bucket, and the overlay tree under it. `overlayPrefix`
 * is what the sweep walks: one listing per user that has any objects, found
 * through `listCommonPrefixes(USER_ROOT)`. */
export const USER_ROOT = "cut/";
export const overlayPrefix = (userId: string) => `cut/${userId}/overlays/`;
export const overlayKey = (userId: string, batchId: string, name: string) =>
  `${overlayPrefix(userId)}${batchId}/${name}`;

/** Scratch media a hosted inference call carries — reference sheets, keyframes,
 * chat attachments. Keyed by the SHA-256 of the bytes, so a sheet that rides
 * into thirty calls uploads once and every caller addresses it by content.
 * These live outside the per-user media prefix: they are not the user's media,
 * they never count against a storage quota, and the sweep finds them by prefix
 * rather than by row. */
export const INFERENCE_PREFIX = "cut/inference/";
export const inferenceBlobKey = (userId: string, sha256: string, ext: string) =>
  `${INFERENCE_PREFIX}${userId}/${sha256}.${ext}`;

/** Files a phone sends before the computer takes them in. They sit outside
 * `cut/` so the per-user sweeps never walk them; the phone sweep finds them by
 * row, and the bytes never count against a storage quota. */
export const PHONE_STAGING_PREFIX = "cut-phone/";
export const phoneStagingKey = (userId: string, dropId: string, fileId: string) =>
  `${PHONE_STAGING_PREFIX}${userId}/${dropId}/${fileId}`;
export const phoneThumbKey = (userId: string, dropId: string, fileId: string) =>
  `${PHONE_STAGING_PREFIX}${userId}/${dropId}/${fileId}.thumb.jpg`;

/** A time-limited PUT URL. `bytes` pins the object size into the signature:
 * the claim the quota was checked against is the most R2 will accept, and a
 * larger body is a 403 at the bucket. Left out only for transient inputs the
 * quota never sees. */
export function presignPut(key: string, mime: string, bytes?: number): Promise<string> {
  return getSignedUrl(
    r2(),
    new PutObjectCommand({
      Bucket: R2_BUCKET,
      Key: key,
      ContentType: mime,
      ...(bytes !== undefined ? { ContentLength: bytes } : {}),
    }),
    { expiresIn: PUT_EXPIRY_SECONDS }
  );
}

/** A time-limited read URL, for handing an object to an inference provider
 * that fetches its input itself. */
export function presignGet(key: string): Promise<string> {
  return getSignedUrl(r2(), new GetObjectCommand({ Bucket: R2_BUCKET, Key: key }), {
    expiresIn: PUT_EXPIRY_SECONDS,
  });
}


/** Object size/type, or null when the object does not exist. */
export async function head(
  key: string
): Promise<{ bytes: number; mime: string; etag: string } | null> {
  try {
    const res = await r2().send(new HeadObjectCommand({ Bucket: R2_BUCKET, Key: key }));
    return {
      bytes: Number(res.ContentLength ?? 0),
      mime: res.ContentType ?? "",
      // Quoted on the wire, and the quotes would need escaping in a URL.
      etag: (res.ETag ?? "").replace(/[^\w]/g, ""),
    };
  } catch (e) {
    if (e instanceof R2NotConfiguredError) throw e;
    return null;
  }
}

/** An object's bytes, or null when it does not exist. */
export async function getObject(key: string): Promise<{ bytes: Buffer; mime: string } | null> {
  try {
    const res = await r2().send(new GetObjectCommand({ Bucket: R2_BUCKET, Key: key }));
    const body = res.Body;
    if (!body) return null;
    return {
      bytes: Buffer.from(await body.transformToByteArray()),
      mime: res.ContentType ?? "application/octet-stream",
    };
  } catch (e) {
    if (e instanceof R2NotConfiguredError) throw e;
    return null;
  }
}

/**
 * Delete everything under `prefix`, paging until the listing is empty.
 *
 * Deleting a tree cannot be "list once, then delete": an HLS ladder for a long
 * cut runs to tens of thousands of objects, and a single capped listing would
 * leave the remainder behind with nothing left pointing at it. Returns how many
 * objects went.
 */
export async function deletePrefix(prefix: string): Promise<number> {
  let removed = 0;
  // Bounded so a listing that somehow never drains cannot spin forever; each
  // pass removes up to 1000, so this is far above any real ladder.
  for (let pass = 0; pass < 1000; pass++) {
    const keys = await listUnder(prefix, 1000);
    if (keys.length === 0) return removed;
    await del(keys);
    removed += keys.length;
    // A delete that silently removed nothing would otherwise loop on the same
    // page: del swallows its own failures, so treat no progress as done.
    if (keys.length < 1000) return removed;
  }
  return removed;
}

/** Every key under `prefix`, up to `limit`. Callers deleting a whole tree
 * should use deletePrefix, which pages instead of truncating. */
export async function listUnder(prefix: string, limit = 10_000): Promise<string[]> {
  const out: string[] = [];
  let token: string | undefined;
  do {
    const res = await r2().send(
      new ListObjectsV2Command({
        Bucket: R2_BUCKET,
        Prefix: prefix,
        ContinuationToken: token,
        MaxKeys: 1000,
      })
    );
    for (const o of res.Contents ?? []) {
      if (o.Key) out.push(o.Key);
      if (out.length >= limit) return out;
    }
    token = res.IsTruncated ? res.NextContinuationToken : undefined;
  } while (token);
  return out;
}

/** Keys and last-write times under `prefix` — freshness checks without
 * per-object GETs. */
export async function listObjectsWithDates(
  prefix: string,
  limit = 10_000
): Promise<{ key: string; lastModified: Date }[]> {
  const out: { key: string; lastModified: Date }[] = [];
  let token: string | undefined;
  do {
    const res = await r2().send(
      new ListObjectsV2Command({
        Bucket: R2_BUCKET,
        Prefix: prefix,
        ContinuationToken: token,
        MaxKeys: 1000,
      })
    );
    for (const o of res.Contents ?? []) {
      if (o.Key && o.LastModified) out.push({ key: o.Key, lastModified: o.LastModified });
      if (out.length >= limit) return out;
    }
    token = res.IsTruncated ? res.NextContinuationToken : undefined;
  } while (token);
  return out;
}

/** The "directories" directly under `prefix` — one entry per distinct next
 * path segment, without listing the objects inside. A sweep that walks every
 * user's tree starts here instead of from a table scan. */
export async function listCommonPrefixes(prefix: string): Promise<string[]> {
  const out: string[] = [];
  let token: string | undefined;
  do {
    const res = await r2().send(
      new ListObjectsV2Command({
        Bucket: R2_BUCKET,
        Prefix: prefix,
        Delimiter: "/",
        ContinuationToken: token,
        MaxKeys: 1000,
      })
    );
    for (const p of res.CommonPrefixes ?? []) if (p.Prefix) out.push(p.Prefix);
    token = res.IsTruncated ? res.NextContinuationToken : undefined;
  } while (token);
  return out;
}

/** Keys under `prefix` last written before `before`, paged to `limit` objects.
 * For prefix sweeps of objects no database row tracks. */
export async function listOlderThan(
  prefix: string,
  before: Date,
  limit = 5000
): Promise<string[]> {
  const out: string[] = [];
  let token: string | undefined;
  do {
    const res = await r2().send(
      new ListObjectsV2Command({
        Bucket: R2_BUCKET,
        Prefix: prefix,
        ContinuationToken: token,
        MaxKeys: 1000,
      })
    );
    for (const o of res.Contents ?? []) {
      if (o.Key && o.LastModified && o.LastModified < before) out.push(o.Key);
      if (out.length >= limit) return out;
    }
    token = res.IsTruncated ? res.NextContinuationToken : undefined;
  } while (token);
  return out;
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

// --- Multipart: a large file in parts, each its own PUT that can be resent. ---

/** Start a multipart upload and return its id. */
export async function createMultipart(key: string, mime: string): Promise<string> {
  const res = await r2().send(new CreateMultipartUploadCommand({ Bucket: R2_BUCKET, Key: key, ContentType: mime }));
  if (!res.UploadId) throw new Error("R2 returned no upload id");
  return res.UploadId;
}

/** A time-limited PUT URL for one part. Parts are numbered from 1. */
export function presignPart(key: string, uploadId: string, partNumber: number): Promise<string> {
  return getSignedUrl(
    r2(),
    new UploadPartCommand({ Bucket: R2_BUCKET, Key: key, UploadId: uploadId, PartNumber: partNumber }),
    { expiresIn: PUT_EXPIRY_SECONDS }
  );
}

/** Join the uploaded parts into the object. The parts' ETags come from R2's own
 * listing, so the browser that sent them never has to read a response header
 * the bucket's CORS rules might hide. */
export async function completeMultipart(key: string, uploadId: string): Promise<void> {
  const s3 = r2();
  const parts: CompletedPart[] = [];
  let marker: string | undefined;
  for (;;) {
    const page = await s3.send(
      new ListPartsCommand({ Bucket: R2_BUCKET, Key: key, UploadId: uploadId, PartNumberMarker: marker })
    );
    for (const p of page.Parts ?? []) {
      parts.push({ PartNumber: p.PartNumber, ETag: p.ETag });
    }
    if (!page.IsTruncated || !page.NextPartNumberMarker) {
      break;
    }
    marker = page.NextPartNumberMarker;
  }
  parts.sort((a, b) => (a.PartNumber ?? 0) - (b.PartNumber ?? 0));
  await s3.send(
    new CompleteMultipartUploadCommand({
      Bucket: R2_BUCKET,
      Key: key,
      UploadId: uploadId,
      MultipartUpload: { Parts: parts },
    })
  );
}

/** Drop an unfinished multipart upload and its parts. Best effort: an upload
 * that already completed or expired has nothing left to abort. */
export async function abortMultipart(key: string, uploadId: string): Promise<void> {
  try {
    await r2().send(new AbortMultipartUploadCommand({ Bucket: R2_BUCKET, Key: key, UploadId: uploadId }));
  } catch (e) {
    if (e instanceof R2NotConfiguredError) throw e;
  }
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
