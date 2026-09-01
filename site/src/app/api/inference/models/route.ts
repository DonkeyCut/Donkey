import { NextResponse } from "next/server";

import { createProviderRegistry } from "@/lib/inference/router";
import { requireInferenceClientId } from "@/lib/inference/responses";
import { parseRequestedModalities } from "@/lib/inference/schemas";
import {
  INFERENCE_RATE_LIMIT,
  withDonkeyAuth,
} from "@/lib/donkey-api-auth";

export const GET = withDonkeyAuth(async (request) => {
  const client = requireInferenceClientId(request.donkey.clientId);
  if (!client.ok) {
    return client.response;
  }

  const modalities = parseRequestedModalities(
    request.nextUrl.searchParams.get("output_modalities"),
  );
  const registry = createProviderRegistry();
  const models = await registry.listModels([...modalities]);

  return NextResponse.json({
    data: models,
  });
}, { rateLimit: INFERENCE_RATE_LIMIT });
