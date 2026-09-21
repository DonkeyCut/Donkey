import { createHash } from "node:crypto";

import type { GenerateContentParameters, Tool } from "@google/genai";

import type { GeminiClient } from "./gemini-client";

// Explicit Gemini context caching for the planner's stable prompt head: the system instruction and the
// tool declarations.
//
// The agent loop sends a byte-identical head on EVERY step of a task — doctrine and skills (~11K tokens)
// plus the declared tool catalog (the whole catalog is ~40K tokens; a turn routed to a few areas is ~20K).
// A call is ~99% input. Caching that head once and referencing it bills those tokens at the reduced cached
// rate rather than full price every step. Vertex does not implicitly cache, so without this the head is
// re-billed in full on all ~37 steps of a run.
//
// The turn judge narrows the tool block per turn (src/cut/lib/turnJudge.ts), so the head varies by routed
// area set. That is what the content-hash key is for: each recurring combination gets its own cache and
// every step of that turn — and every later turn routed the same way — reads it back.
//
// Serverless-safe by construction: the cache lives in Gemini's own registry, looked up by a content-hash
// displayName, so reuse survives across isolated function invocations with no shared store of our own. A
// best-effort per-process memo skips the lookup on back-to-back calls a warm instance happens to handle.
// EVERY failure path falls back to the inline head, so caching can only reduce cost — it can never break a
// call.

// Cache lifetime on Gemini's side. Long enough to span a whole run, short enough that stale per-task caches
// expire on their own rather than piling up.
const TTL_SECONDS = 1800;
// Refresh our memo a little before the cache itself expires, so we never hand back a name that just lapsed.
const MEMO_TTL_MS = (TTL_SECONDS - 120) * 1000;
// After a failed resolve, don't retry for a minute — if caching is unavailable (e.g. the head is under the
// provider's minimum cacheable size), this stops every step from re-attempting it.
const NEGATIVE_TTL_MS = 60_000;
// Below ~1K tokens caching isn't worth a round-trip and the provider rejects it; gate on a char proxy.
const MIN_CACHEABLE_CHARS = 4_096;
const DISPLAY_NAME_PREFIX = "donkey-ctx-";
// Bound the registry scan so a long cache list can't stall a request.
const MAX_LIST_SCAN = 300;

// hash → resolved cache name (or "" as a short-lived negative entry). Lost on cold start; correctness comes
// from the list-or-create below — this only avoids a list round-trip when one instance handles a burst.
const memo = new Map<string, { name: string; expiresAt: number }>();

/** The cacheable head of a request: whichever of the instruction and the tools it carries. */
interface CacheHead {
  systemInstruction?: string;
  tools?: Tool[];
}

function displayNameFor(head: CacheHead): string {
  // Both parts ride the key: a turn routed to different areas is a different head and must not read back
  // another turn's cache.
  const material = JSON.stringify([head.systemInstruction ?? "", head.tools ?? []]);
  const hash = createHash("sha256").update(material).digest("hex").slice(0, 40);
  return `${DISPLAY_NAME_PREFIX}${hash}`;
}

function headChars(head: CacheHead): number {
  return (head.systemInstruction?.length ?? 0) + (head.tools ? JSON.stringify(head.tools).length : 0);
}

function cacheIsLive(expireTime: string | undefined, nowMs: number): boolean {
  if (!expireTime) {
    return true;
  }
  const expiry = Date.parse(expireTime);
  // Treat an unparseable time as live (let the provider be the judge); require a 30s margin otherwise.
  return Number.isNaN(expiry) ? true : expiry > nowMs + 30_000;
}

async function resolveCachedHead(args: {
  client: GeminiClient;
  model: string;
  head: CacheHead;
  nowMs: number;
}): Promise<string | null> {
  const { client, model, head, nowMs } = args;
  const displayName = displayNameFor(head);
  const memoKey = `${model}:${displayName}`;

  const remembered = memo.get(memoKey);
  if (remembered && remembered.expiresAt > nowMs) {
    return remembered.name || null;
  }

  try {
    // Reuse a live cache created by this or any other instance for the identical head.
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
      config: {
        ...(head.systemInstruction ? { systemInstruction: head.systemInstruction } : {}),
        ...(head.tools ? { tools: head.tools } : {}),
        displayName,
        ttl: `${TTL_SECONDS}s`,
      },
    });
    if (created.name) {
      memo.set(memoKey, { name: created.name, expiresAt: nowMs + MEMO_TTL_MS });
      return created.name;
    }
    return null;
  } catch {
    // Under the provider's minimum cacheable size, a transient API error, or caching disabled — remember
    // the miss briefly so we don't re-attempt every step, and let the caller keep the inline head.
    memo.set(memoKey, { name: "", expiresAt: nowMs + NEGATIVE_TTL_MS });
    return null;
  }
}

/**
 * Swap a large, repeated inline prompt head — the system instruction and the tool declarations — for a
 * cached reference, in place on `requestParameters`. Applies where the same head recurs every step; short
 * heads are left untouched. A no-op on any failure, so the request always stays valid.
 */
export async function applyContextCacheToRequest(
  requestParameters: GenerateContentParameters,
  client: GeminiClient,
): Promise<void> {
  const config = requestParameters.config;
  if (!config) {
    return;
  }
  const head: CacheHead = {
    ...(typeof config.systemInstruction === "string" ? { systemInstruction: config.systemInstruction } : {}),
    ...(Array.isArray(config.tools) && config.tools.length > 0 ? { tools: config.tools as Tool[] } : {}),
  };
  // A tool config steers declarations the cache would then own; leave those calls inline.
  if (config.toolConfig || headChars(head) < MIN_CACHEABLE_CHARS) {
    return;
  }

  const cacheName = await resolveCachedHead({ client, model: requestParameters.model, head, nowMs: Date.now() });
  if (!cacheName) {
    return;
  }

  // A cache holds the head, so the call references it and sends neither part inline.
  config.cachedContent = cacheName;
  delete config.systemInstruction;
  delete config.tools;
}
