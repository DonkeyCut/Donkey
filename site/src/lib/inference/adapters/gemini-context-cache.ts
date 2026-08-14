import { createHash } from "node:crypto";

import type { GenerateContentParameters } from "@google/genai";

import type { GeminiClient } from "./gemini-client";

// Explicit Gemini context caching for the planner's stable system instruction.
//
// The agent loop sends a byte-identical system-instruction block (doctrine + the whole tool catalog +
// skills, ~11K tokens) on EVERY step of a task — a call is ~99% input. Caching that block once and
// referencing it bills those tokens at the reduced cached rate instead of full price every step. Vertex
// does not implicitly cache, so without this the block is re-billed in full on all ~37 steps of a run.
//
// Serverless-safe by construction: the cache lives in Gemini's own registry, looked up by a content-hash
// displayName, so reuse survives across isolated function invocations with no shared store of our own. A
// best-effort per-process memo skips the lookup on back-to-back calls a warm instance happens to handle.
// EVERY failure path falls back to the inline system instruction, so caching can only reduce cost — it can
// never break a call.

// Cache lifetime on Gemini's side. Long enough to span a whole run, short enough that stale per-task caches
// expire on their own rather than piling up.
const TTL_SECONDS = 1800;
// Refresh our memo a little before the cache itself expires, so we never hand back a name that just lapsed.
const MEMO_TTL_MS = (TTL_SECONDS - 120) * 1000;
// After a failed resolve, don't retry for a minute — if caching is unavailable (e.g. the instruction is
// under the provider's minimum cacheable size), this stops every step from re-attempting it.
const NEGATIVE_TTL_MS = 60_000;
// Below ~1K tokens caching isn't worth a round-trip and the provider rejects it; gate on a char proxy.
const MIN_CACHEABLE_CHARS = 4_096;
const DISPLAY_NAME_PREFIX = "donkey-ctx-";
// Bound the registry scan so a long cache list can't stall a request.
const MAX_LIST_SCAN = 300;

// hash → resolved cache name (or "" as a short-lived negative entry). Lost on cold start; correctness comes
// from the list-or-create below — this only avoids a list round-trip when one instance handles a burst.
const memo = new Map<string, { name: string; expiresAt: number }>();

function displayNameFor(systemInstruction: string): string {
  const hash = createHash("sha256").update(systemInstruction).digest("hex").slice(0, 40);
  return `${DISPLAY_NAME_PREFIX}${hash}`;
}

function cacheIsLive(expireTime: string | undefined, nowMs: number): boolean {
  if (!expireTime) {
    return true;
  }
  const expiry = Date.parse(expireTime);
  // Treat an unparseable time as live (let the provider be the judge); require a 30s margin otherwise.
  return Number.isNaN(expiry) ? true : expiry > nowMs + 30_000;
}

async function resolveCachedSystemInstruction(args: {
  client: GeminiClient;
  model: string;
  systemInstruction: string;
  nowMs: number;
}): Promise<string | null> {
  const { client, model, systemInstruction, nowMs } = args;
  const displayName = displayNameFor(systemInstruction);
  const memoKey = `${model}:${displayName}`;

  const remembered = memo.get(memoKey);
  if (remembered && remembered.expiresAt > nowMs) {
    return remembered.name || null;
  }

  try {
    // Reuse a live cache created by this or any other instance for the identical instruction.
    const pager = await client.caches.list({ config: { pageSize: 100 } });
    let scanned = 0;
    for await (const cache of pager) {
      if (++scanned > MAX_LIST_SCAN) {
        break;
      }
      if (cache.displayName === displayName && cache.name && cacheIsLive(cache.expireTime, nowMs)) {
        memo.set(memoKey, { name: cache.name, expiresAt: nowMs + MEMO_TTL_MS });
        return cache.name;
      }
    }

    const created = await client.caches.create({
      model,
      config: { systemInstruction, displayName, ttl: `${TTL_SECONDS}s` },
    });
    if (created.name) {
      memo.set(memoKey, { name: created.name, expiresAt: nowMs + MEMO_TTL_MS });
      return created.name;
    }
    return null;
  } catch {
    // Under the provider's minimum cacheable size, a transient API error, or caching disabled — remember
    // the miss briefly so we don't re-attempt every step, and let the caller keep the inline instruction.
    memo.set(memoKey, { name: "", expiresAt: nowMs + NEGATIVE_TTL_MS });
    return null;
  }
}

/**
 * Swap a large, repeated inline system instruction for a cached reference, in place on `requestParameters`.
 * Applies where the same instruction recurs every step; short instructions are left untouched.
 * A no-op on any failure, so the request always stays valid.
 */
export async function applyContextCacheToRequest(
  requestParameters: GenerateContentParameters,
  client: GeminiClient,
): Promise<void> {
  const config = requestParameters.config;
  const systemInstruction = config?.systemInstruction;
  if (!config || typeof systemInstruction !== "string" || systemInstruction.length < MIN_CACHEABLE_CHARS) {
    return;
  }

  const cacheName = await resolveCachedSystemInstruction({
    client,
    model: requestParameters.model,
    systemInstruction,
    nowMs: Date.now(),
  });
  if (!cacheName) {
    return;
  }

  // A cache holds the system instruction, so the call must reference it WITHOUT also sending one inline.
  config.cachedContent = cacheName;
  delete config.systemInstruction;
}
