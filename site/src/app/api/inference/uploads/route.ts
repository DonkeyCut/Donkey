import { NextResponse } from "next/server";

import {
  head,
  inferenceBlobKey,
  presignPut,
  R2NotConfiguredError,
} from "@/cut/server/cloud/r2";
import {
  requireInferenceClientId,
  validationErrorResponse,
} from "@/lib/inference/responses";
import { inferenceUploadRequestSchema } from "@/lib/inference/schemas";
import { withDonkeyAuth } from "@/lib/donkey-api-auth";

export const dynamic = "force-dynamic";

// Media a hosted inference call carries rides object storage rather than the
// request body (see lib/inference/blobs.ts). This mints the upload URLs: one
// content-addressed key per picture or sound, and a direct PUT the browser sends
// the bytes to. Nothing is billed here — the render that follows is.
//
// A key already in storage comes back without a URL, so the reference sheet a
// scene run rides into every shot uploads once for the whole run.
const MAX_BLOB_BYTES = 32 * 1024 * 1024;

const EXTENSIONS: Record<string, string> = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/webp": "webp",
  "image/gif": "gif",
  "audio/mpeg": "mp3",
  "audio/mp4": "m4a",
  "audio/aac": "aac",
  "audio/wav": "wav",
  "audio/x-wav": "wav",
  "audio/webm": "weba",
  "audio/ogg": "ogg",
  "video/mp4": "mp4",
  "video/quicktime": "mov",
  "video/webm": "webm",
};

export const POST = withDonkeyAuth(async (request) => {
  const client = requireInferenceClientId(request.donkey.clientId);
  if (!client.ok) {
    return client.response;
  }

  const parsed = inferenceUploadRequestSchema.safeParse(await request.json());
  if (!parsed.success) {
    return validationErrorResponse(parsed.error);
  }

  try {
    // Per-item outcomes, in request order: one blob this route can't take never
    // costs the caller the rest of the batch. A skipped blob rides the request
    // body as before, which is what it would have done anyway.
    const blobs = await Promise.all(
      parsed.data.blobs.map(async (blob) => {
        const ext = EXTENSIONS[blob.mimeType];
        if (!ext) return { skipped: "unsupported" };
        if (blob.bytes > MAX_BLOB_BYTES) return { skipped: "too_large" };
        const key = inferenceBlobKey(request.donkey.userId, blob.sha256, ext);
        const stored = await head(key);
        if (stored && stored.bytes === blob.bytes) {
          return { blobRef: key };
        }
        return { blobRef: key, putUrl: await presignPut(key, blob.mimeType) };
      }),
    );
    return NextResponse.json({ blobs });
  } catch (error) {
    if (error instanceof R2NotConfiguredError) {
      return NextResponse.json(
        {
          error: "storage_unavailable",
          message: "Media storage is not configured.",
        },
        { status: 503 },
      );
    }
    throw error;
  }
});
