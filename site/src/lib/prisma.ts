import { PrismaPg } from "@prisma/adapter-pg";
import type { Pool } from "pg";

import { PrismaClient } from "@/generated/prisma/client";
import { applyDatabasePoolOverride, createDatabasePool } from "@/lib/databasePool";

const globalForPrisma = globalThis as unknown as {
  prisma?: PrismaClient;
  databasePool?: Pool;
};

function createPrismaClient() {
  const connectionString = process.env.DATABASE_URL;

  if (!connectionString) {
    throw new Error("DATABASE_URL is not configured.");
  }

  const pool = globalForPrisma.databasePool ?? createDatabasePool({ connectionString });
  globalForPrisma.databasePool = pool;
  const adapter = new PrismaPg(pool, { disposeExternalPool: true });

  return new PrismaClient({ adapter });
}

export const prisma = globalForPrisma.prisma ?? createPrismaClient();
globalForPrisma.prisma = prisma;

export function configureDatabasePool(overrides: Record<string, unknown>): void {
  if (globalForPrisma.databasePool) {
    applyDatabasePoolOverride(globalForPrisma.databasePool, overrides.databasePool);
  }
}
