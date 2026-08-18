import { NextResponse } from "next/server";
import { z } from "zod";

import { withDonkeyAuth } from "@/lib/donkey-api-auth";
import {
  requireInferenceClientId,
  validationErrorResponse,
} from "@/lib/inference/responses";
import { searchWeb } from "@/lib/inference/web-search";

const webSearchRequestSchema = z.object({
  query: z.string().trim().min(1).max(500),
});

// Web search for the Mac app's web.search tool. Runs Gemini's Google Search grounding on Vertex with
// the backend's service-account credential, so no key reaches the app. Provider-neutral in/out: a
// query in, a grounded summary plus ranked source pages out.
export const POST = withDonkeyAuth(async (request) => {
  const client = requireInferenceClientId(request.donkey.clientId);
  if (!client.ok) {
    return client.response;
  }

  const parsed = webSearchRequestSchema.safeParse(await request.json());
  if (!parsed.success) {
    return validationErrorResponse(parsed.error);
  }

  const result = await searchWeb(parsed.data.query);
  if (!result) {
    return NextResponse.json({ summary: "", sources: [] }, { headers: { "Cache-Control": "no-store" } });
  }

  return NextResponse.json(result, { headers: { "Cache-Control": "no-store" } });
});
