import { NextResponse } from "next/server";
import { z } from "zod";

import { recordFailedInferenceUsage, recordInferenceUsage } from "@/lib/credits/inference";
import { adminPost } from "@/lib/blog/admin";
import {
  generateBlogDetails,
  generateBlogPicture,
  IMAGE_MODEL,
  TEXT_MODEL,
  type BlogDetails,
} from "@/lib/blog/generate";
import { storeBlogImage } from "@/lib/blog/images";
import { revalidateBlogLater } from "@/lib/blog/revalidate";
import { invalidResponse } from "@/lib/config/experimentList";
import { InferenceProviderError, type JsonValue } from "@/lib/inference/providers";
import { notFoundResponse, shouldBypassDonkeyInferenceCredits, withSuperUser } from "@/lib/donkey-api-auth";
import { prisma } from "@/lib/prisma";

type Params = { params: Promise<{ id: string }> };
const idSchema = z.string().trim().min(1);

const ROUTE = "/api/su/blog/posts/[id]/generate";
const PROVIDER = "gemini";

// The editor sends the article as it stands in the form, saved or not.
const bodySchema = z
  .object({
    title: z.string().trim().max(200),
    body: z.string().trim().min(1, "Write the article first.").max(2_000_000),
  })
  .strict();

// Fills the details from the article: the copy comes back for the form, the
// picture is stored as the header and the thumbnail. Every model call is
// recorded against the editor's account as included usage.
export const POST = withSuperUser(async (request, { params }: Params) => {
  const id = idSchema.safeParse((await params).id);
  if (!id.success) return notFoundResponse();
  const parsed = bodySchema.safeParse(await request.json());
  if (!parsed.success) return invalidResponse(parsed.error.issues);
  const existing = await prisma.blogPost.findUnique({ select: { id: true }, where: { id: id.data } });
  if (!existing) return notFoundResponse();
  // A dev-bypass caller has no account row to record against.
  const recorded = !shouldBypassDonkeyInferenceCredits(request.donkey);
  const usageOf = (requestKind: string, model: string) => ({
    billingMode: "included" as const,
    clientId: null,
    model,
    provider: PROVIDER,
    requestKind,
    route: ROUTE,
    userId: request.donkey.userId,
  });
  const succeeded = async (requestKind: string, model: string, usage: JsonValue) => {
    if (recorded) await recordInferenceUsage({ ...usageOf(requestKind, model), status: "succeeded", usage });
  };
  const failed = async (requestKind: string, model: string) => {
    if (recorded) await recordFailedInferenceUsage({ ...usageOf(requestKind, model), errorCode: "provider_error" });
  };

  let details: BlogDetails;
  try {
    const generated = await generateBlogDetails(parsed.data.title, parsed.data.body);
    details = generated.value;
    await succeeded("blog_details", TEXT_MODEL, generated.usage);
  } catch (error) {
    await failed("blog_details", TEXT_MODEL);
    return failure(error);
  }

  let picture: Buffer;
  try {
    const generated = await generateBlogPicture(details.imagePrompt);
    picture = generated.value;
    await succeeded("blog_picture", IMAGE_MODEL, generated.usage);
  } catch (error) {
    await failed("blog_picture", IMAGE_MODEL);
    return failure(error);
  }

  const [header, thumbnail] = await Promise.all([
    storeBlogImage(existing.id, picture, "header"),
    storeBlogImage(existing.id, picture, "thumbnail"),
  ]);
  const row = await prisma.blogPost.update({
    where: { id: existing.id },
    data: { headerKey: header.key, thumbnailKey: thumbnail.key },
  });
  revalidateBlogLater([row.slug]);

  const { seoTitle, excerpt, summary, tags, keywords, headerAlt } = details;
  return NextResponse.json({ post: adminPost(row), details: { seoTitle, excerpt, summary, tags, keywords, headerAlt } });
});

function failure(error: unknown) {
  if (error instanceof InferenceProviderError) {
    return NextResponse.json({ error: error.message }, { status: error.statusCode ?? 502 });
  }
  throw error;
}
