import { cutPhoneCatchAll } from "@/cut/server/cloud/phoneRoutes";

// Upload from phone: the phone's browser sends files into a place the signed-in
// computer opened, with no session of its own. Deliberately NOT wrapped in
// withDonkeyAuth, so this is one of the named public exceptions (see
// docs/guides/backend-apis.md). The code in the QR and the send pass it buys
// authorize each request inside the route table.

const handle = (request: Request) => cutPhoneCatchAll(request);

export const POST = handle;
export const PUT = handle;
