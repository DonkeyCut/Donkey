import type { NextRequest } from "next/server";
import { isVercelCron, withSuperUser } from "@/lib/donkey-api-auth";
import { cleanupConnections } from "@/clients/chatgpt/server/cleanup";

const admin = withSuperUser(cleanupConnections);
/** GET /api/chatgpt/gc: expire OAuth families and consent challenges daily. */
export const GET = async (request: NextRequest) =>
  (await isVercelCron(request)) ? cleanupConnections() : admin(request);
