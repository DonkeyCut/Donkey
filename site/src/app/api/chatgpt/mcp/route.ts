export { mcpEndpoint as POST } from "@/clients/chatgpt/server/mcp";
// The stateless transport has no event stream or session to terminate.
export function GET() { return new Response(null, { status: 405, headers: { Allow: "POST" } }); }
export const DELETE = GET;
