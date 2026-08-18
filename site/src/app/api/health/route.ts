import { connection, NextResponse } from "next/server";

export async function GET() {
  // A health check answers for the running deployment: awaiting the connection
  // holds the handler until a real request arrives, so the env is read then.
  await connection();
  return NextResponse.json({
    ok: true,
    services: {
      databaseUrlConfigured: Boolean(process.env.DATABASE_URL),
      directUrlConfigured: Boolean(process.env.DIRECT_URL),
    },
  });
}
