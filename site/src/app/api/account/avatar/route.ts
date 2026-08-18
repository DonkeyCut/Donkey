import { NextResponse } from "next/server";

import {
  notFoundResponse,
  withDonkeyAuth,
  type DonkeyAuthenticatedRequest,
} from "@/lib/donkey-api-auth";
import { accountProfile } from "@/lib/account-profile";
import { prisma } from "@/lib/prisma";

// The client crops to a square and re-encodes before uploading, so anything
// arriving here is already small. The cap is a backstop against a caller that
// skips that path, not a size the UI ever approaches.
const MAX_BYTES = 256 * 1024;
const ALLOWED_TYPES = new Set(["image/webp", "image/jpeg", "image/png"]);

// The signed-in user's own uploaded picture. Callers address it without a user
// id — the session decides whose bytes come back — and the profile hands out a
// URL stamped with `updatedAt`, so the response can be cached hard and a new
// upload lands on a new URL.
export const GET = withDonkeyAuth(async (request: DonkeyAuthenticatedRequest) => {
  const avatar = await prisma.userAvatar.findUnique({
    where: { userId: request.donkey.userId },
  });
  if (!avatar) return notFoundResponse();

  return new NextResponse(new Blob([avatar.data], { type: avatar.contentType }), {
    headers: {
      "Cache-Control": "private, max-age=31536000, immutable",
      "Content-Type": avatar.contentType,
      "X-Content-Type-Options": "nosniff",
    },
  });
});

export const PUT = withDonkeyAuth(async (request: DonkeyAuthenticatedRequest) => {
  const contentType = request.headers.get("content-type")?.split(";")[0].trim() ?? "";
  if (!ALLOWED_TYPES.has(contentType)) {
    return NextResponse.json({ error: "Unsupported image type." }, { status: 415 });
  }

  const data = new Uint8Array(await request.arrayBuffer());
  if (data.byteLength === 0 || data.byteLength > MAX_BYTES) {
    return NextResponse.json({ error: "Image too large." }, { status: 413 });
  }

  const userId = request.donkey.userId;
  await prisma.userAvatar.upsert({
    create: { contentType, data, userId },
    update: { contentType, data },
    where: { userId },
  });

  return NextResponse.json(await accountProfile(userId));
});

export const DELETE = withDonkeyAuth(async (request: DonkeyAuthenticatedRequest) => {
  const userId = request.donkey.userId;
  await prisma.userAvatar.deleteMany({ where: { userId } });
  return NextResponse.json(await accountProfile(userId));
});
