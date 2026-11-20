import { librarySharing } from "@/cut/server/cloud/librarySharing";

// The image a link to a shared library item unfurls with. Crawlers fetch this
// directly, so it answers for the token alone, with no client bundle in the way.

export async function GET(request: Request, { params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  return librarySharing.card(request, token);
}
