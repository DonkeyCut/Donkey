import { attachDatabasePool } from "@vercel/functions";
import { Pool, type PoolConfig } from "pg";

import { SETTINGS } from "@/lib/config/registry";

export function createDatabasePool(config: PoolConfig): Pool {
  const settings = SETTINGS.databasePool.default;
  const pool = new Pool({
    ...config,
    max: settings.maxConnections,
    idleTimeoutMillis: settings.idleTimeoutMs,
    connectionTimeoutMillis: settings.connectionTimeoutMs,
    allowExitOnIdle: true,
  });
  attachDatabasePool(pool);
  return pool;
}

export function applyDatabasePoolOverride(pool: Pool, value: unknown): void {
  const parsed = SETTINGS.databasePool.schema.safeParse(value ?? SETTINGS.databasePool.default);
  if (!parsed.success) {
    console.error('[config] override for setting "databasePool" no longer parses; skipped');
  }
  const settings = parsed.success ? parsed.data : SETTINGS.databasePool.default;
  // Updating the pool keeps checked-out transactions alive. Existing idle
  // connections retain their deadline; new acquisitions use the new limits.
  pool.options.max = settings.maxConnections;
  pool.options.idleTimeoutMillis = settings.idleTimeoutMs;
  pool.options.connectionTimeoutMillis = settings.connectionTimeoutMs;
}
