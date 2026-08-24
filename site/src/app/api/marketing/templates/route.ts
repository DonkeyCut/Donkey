import { NextResponse } from "next/server";
import { z } from "zod";

import { notFoundResponse, withSuperUser } from "@/lib/donkey-api-auth";
import { prisma } from "@/lib/prisma";

// A template is written outside the repo and saved here, so adding one never
// needs a deploy. Same length limits as a send, since a template is only ever
// the starting text of one.
const saveSchema = z
  .object({
    body: z.string().trim().min(1).max(5000),
    name: z.string().trim().min(1).max(80),
    subject: z.string().trim().min(1).max(200),
  })
  .strict();

const templateSelect = {
  body: true,
  id: true,
  name: true,
  subject: true,
  updatedAt: true,
} as const;

type TemplateRow = {
  body: string;
  id: string;
  name: string;
  subject: string;
  updatedAt: Date;
};

function serialize(row: TemplateRow) {
  return {
    body: row.body,
    id: row.id,
    name: row.name,
    subject: row.subject,
    updatedAt: row.updatedAt.toISOString(),
  };
}

export const GET = withSuperUser(async () => {
  const templates = await prisma.outreachTemplate.findMany({
    orderBy: { name: "asc" },
    select: templateSelect,
  });
  return NextResponse.json({ templates: templates.map(serialize) });
});

// Saving under a name that already exists rewrites it, so editing a template is
// the same action as writing one.
export const POST = withSuperUser(async (request) => {
  const parsed = saveSchema.safeParse(await request.json());
  if (!parsed.success) {
    return NextResponse.json(
      {
        error: "Invalid request",
        issues: parsed.error.issues.map((issue) => ({
          message: issue.message,
          path: issue.path.join("."),
        })),
      },
      { status: 400 },
    );
  }

  const { body, name, subject } = parsed.data;
  const template = await prisma.outreachTemplate.upsert({
    create: { actorUserId: request.donkey.userId, body, name, subject },
    select: templateSelect,
    update: { actorUserId: request.donkey.userId, body, subject },
    where: { name },
  });
  return NextResponse.json({ template: serialize(template) });
});

export const DELETE = withSuperUser(async (request) => {
  const id = new URL(request.url).searchParams.get("id");
  if (!id) {
    return NextResponse.json({ error: "Missing id" }, { status: 400 });
  }
  const { count } = await prisma.outreachTemplate.deleteMany({ where: { id } });
  if (count === 0) {
    return notFoundResponse();
  }
  return NextResponse.json({ ok: true });
});
