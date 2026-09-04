import { NextResponse } from "next/server";
import { z } from "zod";

import type { Prisma } from "@/generated/prisma/client";
import { SETTINGS, SETTING_KEYS, isSettingKey } from "@/lib/config/registry";
import { notFoundResponse, withSuperUser } from "@/lib/donkey-api-auth";
import { prisma } from "@/lib/prisma";

// The settings registry as su sees it: every declared key with its default,
// its override when one exists, and its schema for the form. Writes parse
// against the key's own schema, so a stored override always reads back.

const putSchema = z.object({ key: z.string(), value: z.unknown() }).strict();

async function listSettings() {
  const rows = await prisma.settingOverride.findMany();
  const overrides = new Map(rows.map((row) => [row.key, row]));
  return SETTING_KEYS.map((key) => {
    const def = SETTINGS[key];
    const row = overrides.get(key);
    const parsed = row ? def.schema.safeParse(row.value) : null;
    return {
      key,
      title: def.title,
      description: def.description,
      public: def.public,
      default: def.default,
      value: parsed?.success ? parsed.data : def.default,
      overridden: row !== undefined,
      invalid: parsed !== null && !parsed.success,
      updatedAt: row?.updatedAt.toISOString() ?? null,
      schema: z.toJSONSchema(def.schema),
    };
  });
}

export const GET = withSuperUser(async () => {
  return NextResponse.json({ settings: await listSettings() });
});

export const PUT = withSuperUser(async (request) => {
  const parsed = putSchema.safeParse(await request.json());
  if (!parsed.success || !isSettingKey(parsed.data.key)) {
    return NextResponse.json(
      { error: "Invalid request", issues: [{ path: "key", message: "Unknown setting." }] },
      { status: 400 },
    );
  }
  const { key } = parsed.data;
  const value = SETTINGS[key].schema.safeParse(parsed.data.value);
  if (!value.success) {
    return NextResponse.json(
      {
        error: "Invalid request",
        issues: value.error.issues.map((issue) => ({
          message: issue.message,
          path: ["value", ...issue.path].join("."),
        })),
      },
      { status: 400 },
    );
  }
  const json = value.data as Prisma.InputJsonValue;
  await prisma.settingOverride.upsert({
    where: { key },
    create: { key, value: json, actorUserId: request.donkey.userId },
    update: { value: json, actorUserId: request.donkey.userId },
  });
  return NextResponse.json({ settings: await listSettings() });
});

export const DELETE = withSuperUser(async (request) => {
  const key = new URL(request.url).searchParams.get("key");
  if (!key || !isSettingKey(key)) {
    return NextResponse.json({ error: "Missing key" }, { status: 400 });
  }
  const { count } = await prisma.settingOverride.deleteMany({ where: { key } });
  if (count === 0) return notFoundResponse();
  return NextResponse.json({ settings: await listSettings() });
});
