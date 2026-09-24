import { EventEmitter } from "node:events";
import { afterEach, describe, expect, test } from "bun:test";
import type { Pool, PoolConfig } from "pg";

import { SETTINGS } from "@/lib/config/registry";
import { applyDatabasePoolOverride, createDatabasePool } from "@/lib/databasePool";

// Exercise pg's real admission queue and idle timers without a database.
class ConnectedClient extends EventEmitter {
  _queryable = true;
  _ending = false;

  connect(callback: () => void): void { queueMicrotask(callback); }
  end(callback?: () => void): void { this._ending = true; callback?.(); }
  ref(): void {}
  unref(): void {}
}

const pools: Pool[] = [];
function createPool(): Pool {
  const pool = createDatabasePool({ Client: ConnectedClient } as unknown as PoolConfig);
  pools.push(pool);
  return pool;
}

afterEach(async () => {
  await Promise.all(pools.splice(0).map((pool) => pool.end()));
});

describe("database connection budget", () => {
  test("parallel requests queue at the per-instance cap and reuse released connections", async () => {
    const pool = createPool();
    const active = await Promise.all(Array.from({ length: SETTINGS.databasePool.default.maxConnections }, () => pool.connect()));
    const queued = pool.connect();
    expect(pool.totalCount).toBe(3);
    expect(pool.waitingCount).toBe(1);
    active[0].release();
    const reused = await queued;
    expect(reused).toBe(active[0]);
    expect(pool.totalCount).toBe(3);
    reused.release();
    active.slice(1).forEach((client) => client.release());
  });

  test("runtime overrides limit new work and bound its wait without interrupting active work", async () => {
    const pool = createPool();
    const active = await pool.connect();
    applyDatabasePoolOverride(pool, { maxConnections: 1, idleTimeoutMs: 100, connectionTimeoutMs: 100 });
    await expect(pool.connect()).rejects.toThrow("timeout exceeded when trying to connect");
    expect(pool.totalCount).toBe(1);
    expect(pool.waitingCount).toBe(0);
    active.release();
    const reused = await pool.connect();
    expect(reused).toBe(active);
    reused.release();
    await new Promise((resolve) => setTimeout(resolve, 150));
    expect(pool.totalCount).toBe(0);
  });

  test("resetting an override restores the defaults on the same pool", async () => {
    const pool = createPool();
    applyDatabasePoolOverride(pool, { maxConnections: 1, idleTimeoutMs: 100, connectionTimeoutMs: 100 });
    applyDatabasePoolOverride(pool, undefined);
    expect(pool.options.max).toBe(SETTINGS.databasePool.default.maxConnections);
    expect(pool.options.idleTimeoutMillis).toBe(SETTINGS.databasePool.default.idleTimeoutMs);
    expect(pool.options.connectionTimeoutMillis).toBe(SETTINGS.databasePool.default.connectionTimeoutMs);
  });

  test("Vercel keeps the request alive until idle connections close", async () => {
    const contextKey = Symbol.for("@vercel/request-context");
    const previousContext: unknown = Reflect.get(globalThis, contextKey);
    const previousUrl = process.env.VERCEL_URL;
    const previousRegion = process.env.VERCEL_REGION;
    const waits: Promise<unknown>[] = [];
    try {
      process.env.VERCEL_URL = "pool-test.vercel.app";
      process.env.VERCEL_REGION = "test";
      Reflect.set(globalThis, contextKey, { get: () => ({ waitUntil: (promise: Promise<unknown>) => waits.push(promise) }) });
      const pool = createPool();
      applyDatabasePoolOverride(pool, { maxConnections: 1, idleTimeoutMs: 100, connectionTimeoutMs: 100 });
      const client = await pool.connect();
      client.release();
      expect(waits).toHaveLength(1);
      await waits[0];
      expect(pool.totalCount).toBe(0);
    } finally {
      if (previousUrl === undefined) delete process.env.VERCEL_URL;
      else process.env.VERCEL_URL = previousUrl;
      if (previousRegion === undefined) delete process.env.VERCEL_REGION;
      else process.env.VERCEL_REGION = previousRegion;
      if (previousContext === undefined) Reflect.deleteProperty(globalThis, contextKey);
      else Reflect.set(globalThis, contextKey, previousContext);
    }
  });
});
