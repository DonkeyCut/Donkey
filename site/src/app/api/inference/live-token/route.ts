import { NextResponse } from "next/server";

import { withDonkeyAuth } from "@/lib/donkey-api-auth";
import { requireInferenceClientId } from "@/lib/inference/responses";
import { mintVertexLiveConnection } from "@/lib/inference/vertex-live";

// Mints a short-lived Vertex AI access token so a Donkey client can open a
// Gemini Live websocket directly. The long-lived service-account credential
// stays on the backend. Errors propagate raw.
export const POST = withDonkeyAuth(async (request) => {
  const client = requireInferenceClientId(request.donkey.clientId);
  if (!client.ok) {
    return client.response;
  }

  const connection = await mintVertexLiveConnection();
  return NextResponse.json(connection, {
    headers: { "Cache-Control": "no-store" },
  });
});
