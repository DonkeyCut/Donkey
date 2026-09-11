import { randomBytes } from "node:crypto";
import { NextResponse } from "next/server";

import { adminPost, listAdminPosts } from "@/lib/blog/admin";
import { withSuperUser } from "@/lib/donkey-api-auth";
import { prisma } from "@/lib/prisma";

// Every post, newest change first.
export const GET = withSuperUser(async () => {
  return NextResponse.json({ posts: await listAdminPosts() });
});

// A new draft. It exists before anything is typed so images can upload under
// its id; the editor opens on it.
export const POST = withSuperUser(async (request) => {
  const row = await prisma.blogPost.create({
    data: {
      slug: `untitled-${randomBytes(3).toString("hex")}`,
      title: "",
      authorUserId: request.donkey.userId,
    },
  });
  return NextResponse.json({ post: adminPost(row) });
});
