import { createReadStream } from "node:fs";
import { mkdir, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import type { Readable } from "node:stream";
import {
  DeleteObjectsCommand,
  GetObjectCommand,
  PutObjectCommand,
  S3Client,
} from "@aws-sdk/client-s3";

// The worker's own R2 handle: it runs outside the Next server, so it carries
// its own client with file-streaming helpers (multi-GB renders never buffer
// in memory). The key scheme is the hosted API's — re-exported so worker and
// routes can never drift apart.

export {
  projectCardKey as cardKey,
  projectExportKey as exportKey,
  projectHlsPrefix as hlsPrefix,
  projectHlsRoot as hlsRoot,
  projectMediaKey as mediaKey,
  projectPreviewKey as previewKey,
} from "../server/cloud/r2";

const R2_BUCKET = "donkey-cut";

let client: S3Client | null = null;
function r2(): S3Client {
  if (!client) {
    const accountId = process.env.R2_ACCOUNT_ID;
    const accessKeyId = process.env.R2_ACCESS_KEY_ID;
    const secretAccessKey = process.env.R2_SECRET_ACCESS_KEY;
    if (!accountId || !accessKeyId || !secretAccessKey) {
      throw new Error("R2_ACCOUNT_ID, R2_ACCESS_KEY_ID and R2_SECRET_ACCESS_KEY are required.");
    }
    client = new S3Client({
      region: "auto",
      endpoint: `https://${accountId}.r2.cloudflarestorage.com`,
      credentials: { accessKeyId, secretAccessKey },
    });
  }
  return client;
}

/** Best-effort bulk delete; a failure leaves strays for the GC sweep. */
export async function deleteObjects(keys: string[]): Promise<void> {
  if (keys.length === 0) return;
  try {
    await r2().send(
      new DeleteObjectsCommand({
        Bucket: R2_BUCKET,
        Delete: { Objects: keys.map((Key) => ({ Key })), Quiet: true },
      })
    );
  } catch {
    // GC covers what this missed.
  }
}

/** Stream one R2 object to `dest`, creating its directory. */
export async function downloadToFile(key: string, dest: string): Promise<void> {
  const res = await r2().send(new GetObjectCommand({ Bucket: R2_BUCKET, Key: key }));
  if (!res.Body) throw new Error(`Empty R2 object: ${key}`);
  await mkdir(path.dirname(dest), { recursive: true });
  await writeFile(dest, res.Body as Readable);
}

/** Upload a local file to `key`, returning its byte size. */
export async function uploadFile(key: string, file: string, contentType: string): Promise<number> {
  const info = await stat(file);
  await r2().send(
    new PutObjectCommand({
      Bucket: R2_BUCKET,
      Key: key,
      Body: createReadStream(file),
      ContentLength: info.size,
      ContentType: contentType,
    })
  );
  return info.size;
}

/** Upload `files` (paths relative to `dir`) under `keyPrefix`, a few at a time.
 * Returns the total bytes written. An HLS ladder is hundreds of small objects,
 * so this bounds concurrency rather than opening one request per segment. */
export async function uploadTree(
  dir: string,
  keyPrefix: string,
  files: string[],
  concurrency = 8
): Promise<number> {
  let total = 0;
  let next = 0;
  const workers = Array.from({ length: Math.min(concurrency, files.length) }, async () => {
    for (let i = next++; i < files.length; i = next++) {
      const rel = files[i];
      total += await uploadFile(
        `${keyPrefix}/${rel.split(path.sep).join("/")}`,
        path.join(dir, rel),
        mimeFor(rel)
      );
    }
  });
  await Promise.all(workers);
  return total;
}

const MIME_BY_EXT: Record<string, string> = {
  ".mp4": "video/mp4",
  ".mov": "video/quicktime",
  ".m4v": "video/mp4",
  ".webm": "video/webm",
  ".mkv": "video/x-matroska",
  ".mp3": "audio/mpeg",
  ".m4a": "audio/mp4",
  ".aac": "audio/aac",
  ".wav": "audio/wav",
  ".ogg": "audio/ogg",
  ".flac": "audio/flac",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".gif": "image/gif",
  ".avif": "image/avif",
  ".bmp": "image/bmp",
  // HLS. The playlist type matters to players; a wrong one makes Safari refuse
  // the stream outright rather than degrade.
  ".m3u8": "application/vnd.apple.mpegurl",
  ".ts": "video/mp2t",
  ".m4s": "video/iso.segment",
};

export function mimeFor(fileName: string): string {
  return MIME_BY_EXT[path.extname(fileName).toLowerCase()] ?? "application/octet-stream";
}
