import { cutSharedCatchAll } from "@/cut/server/cloud/sharedRoutes";

// The shared-viewer API: read-only access to a shared cloud project by link
// token. Deliberately NOT wrapped in withDonkeyAuth — a public share must open
// with no session — so this is one of the named public exceptions (see
// docs/guides/backend-apis.md). Access control happens per request inside the
// route table's share resolver, and content is filtered to the share's
// settings before it leaves the server.

const handle = (request: Request) => cutSharedCatchAll(request);

export const GET = handle;
export const POST = handle;
export const HEAD = handle;
