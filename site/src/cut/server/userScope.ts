import { AsyncLocalStorage } from "node:async_hooks";
import path from "node:path";
import { cutDataRoot } from "./dataDir";

/**
 * Every data route runs inside a signed-in user's scope: the page sends the
 * Donkey account id with each engine request (the `u` query param api.ts
 * appends), the dispatcher binds it here, and all project/library paths hang
 * off users/<id> under the data root. The engine cannot verify the id — it
 * never talks to the hosted backend — so this is per-account separation on a
 * shared Mac, not protection against a hostile local user.
 */
const scope = new AsyncLocalStorage<string>();

// Donkey account ids are URL-safe tokens; anything else is refused before it
// can become a filesystem path.
const USER_ID_RE = /^[A-Za-z0-9_-]{1,64}$/;

export const isValidCutUser = (id: string) => USER_ID_RE.test(id);

export function runWithCutUser<T>(id: string, fn: () => T): T {
  if (!isValidCutUser(id)) throw new Error("Invalid user id.");
  return scope.run(id, fn);
}

/** The current request's per-user data root. Path helpers build on this, so a
 * path outside a user scope is impossible by construction. */
export function cutUserRoot(): string {
  return path.join(cutDataRoot(), "users", currentCutUser());
}

/** The account id bound to the current request. The AI chat threads it into the
 * spawned MCP proxy so the proxy's own engine calls stay in the same scope. */
export function currentCutUser(): string {
  const id = scope.getStore();
  if (!id) throw new Error("No user scope bound to this request.");
  return id;
}
