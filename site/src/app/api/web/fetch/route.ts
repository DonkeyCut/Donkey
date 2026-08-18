import { NextResponse } from "next/server";
import { z } from "zod";

import { withDonkeyAuth } from "@/lib/donkey-api-auth";
import {
  requireInferenceClientId,
  validationErrorResponse,
} from "@/lib/inference/responses";
import { fetchWebContent } from "@/lib/inference/web-fetch";

const webFetchRequestSchema = z.object({
  url: z.string().trim().url().max(2000),
});

// Web page reader for the Mac app's web.fetch tool. Fetches the page server-side (SSRF-guarded to
// public http(s)) and returns just the main content as clean markdown — nav, ads, and boilerplate
// removed — so the model gets the article instead of raw HTML. Provider-neutral: a URL in, a title
// plus markdown out.
export const POST = withDonkeyAuth(async (request) => {
  const client = requireInferenceClientId(request.donkey.clientId);
  if (!client.ok) {
    return client.response;
  }

  const parsed = webFetchRequestSchema.safeParse(await request.json());
  if (!parsed.success) {
    return validationErrorResponse(parsed.error);
  }

  const result = await fetchWebContent(parsed.data.url);
  if (!result) {
    return NextResponse.json(
      { title: "", markdown: "" },
      { headers: { "Cache-Control": "no-store" } },
    );
  }

  return NextResponse.json(result, { headers: { "Cache-Control": "no-store" } });
});
