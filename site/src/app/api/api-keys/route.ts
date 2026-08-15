import { randomBytes, randomUUID } from "node:crypto";
import { NextResponse } from "next/server";
import {
  API_KEY_PREFIX,
  donkeySessionUserId,
  hashApiKey,
  unauthorizedResponse,
  withDonkeyAuth,
} from "@/lib/donkey-api-auth";
import { prisma } from "@/lib/prisma";

// API keys for the Cut surface, stored in the Better-Auth-shaped Apikey
// table. Managed with the signed-in session only — a key cannot mint or list
// keys. The full secret is returned once, at creation; the row holds its
// hash (`key`) and a display head (`start`).

export const runtime = "nodejs";

const MAX_KEYS = 20;

export const GET = withDonkeyAuth(async (request) => {
  const userId = donkeySessionUserId(request);
  if (!userId) return unauthorizedResponse();
  const rows = await prisma.apikey.findMany({
    where: { referenceId: userId },
    orderBy: { createdAt: "desc" },
    select: {
      id: true,
      name: true,
      start: true,
      enabled: true,
      createdAt: true,
      lastRequest: true,
    },
  });
  return NextResponse.json(rows);
});

export const POST = withDonkeyAuth(async (request) => {
  const userId = donkeySessionUserId(request);
  if (!userId) return unauthorizedResponse();
  const body = (await request.json().catch(() => ({}))) as { name?: string };
  const name = (body.name ?? "").trim() || "API key";
  const live = await prisma.apikey.count({ where: { referenceId: userId, enabled: true } });
  if (live >= MAX_KEYS)
    return NextResponse.json({ error: "Key limit reached. Revoke one first." }, { status: 400 });
  const secret = `${API_KEY_PREFIX}${randomBytes(24).toString("base64url")}`;
  const now = new Date();
  const row = await prisma.apikey.create({
    data: {
      id: randomUUID(),
      name,
      referenceId: userId,
      prefix: API_KEY_PREFIX,
      start: secret.slice(0, API_KEY_PREFIX.length + 6),
      key: hashApiKey(secret),
      enabled: true,
      createdAt: now,
      updatedAt: now,
    },
    select: { id: true, name: true, start: true, createdAt: true },
  });
  return NextResponse.json({ ...row, key: secret });
});
