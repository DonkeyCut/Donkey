export { mcpEndpoint as POST } from "@/clients/chatgpt/server/mcp";
// An edit call waits on the worker for up to chatgptApp.commandWaitMs.
export const maxDuration = 300;
// The stateless transport has no event stream or session to terminate.
export function GET() { return new Response(null, { status: 405, headers: { Allow: "POST" } }); }
export const DELETE = GET;
