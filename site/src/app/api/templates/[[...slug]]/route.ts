import { templatesCatchAll } from "@/cut/server/cloud/templateRoutes";

// The template gallery's API: Donkey's published templates, read-only to
// anyone, the way a public share is. Deliberately NOT wrapped in
// withDonkeyAuth — the gallery and a template's page open with no session —
// so this is one of the named public exceptions (see
// docs/guides/backend-apis.md). Copying into an account and searching read
// the session, each inside its own handler.

const handle = (request: Request) => templatesCatchAll(request);

export const GET = handle;
export const POST = handle;
export const HEAD = handle;
