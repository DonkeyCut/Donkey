// A failure the person reads. It carries a code from the `errors` catalog
// (src/i18n/messages/<locale>/errors.json) and the values its message names,
// so each surface words it in the reader's language; the English message
// stays for logs, the chat model, and anything that only reads `message`.
//
//   throw new UserError("note_save_failed", "Could not save the note.");
//   throw new UserError("file_too_large", "That file is over 4 GB.", { limit: "4 GB" });

import { operationFailure } from "./operationFailure";

export type UserErrorParams = Record<string, string | number>;

export class UserError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly params: UserErrorParams = {},
  ) {
    super(message);
    this.name = "UserError";
  }
}

/** A failure as a JSON reply carries it: the English under `error`, the code
 * and values beside it when it has them. Engine, browser-backend and cloud
 * replies all answer in this shape. */
export type ErrorBody = { error: string; code?: string; params?: UserErrorParams };

/** A failure as a record that holds other fields carries it: a job's status,
 * a persisted tile, an upload row. */
export type ErrorFields = { error?: string; errorCode?: string; errorParams?: UserErrorParams };

const isParams = (value: unknown): value is UserErrorParams =>
  !!value && typeof value === "object" && !Array.isArray(value);

/** The code and values of a failure that has one, whatever carried it: a
 * UserError, an OperationError's failure, a reply body's `code`, a record's
 * `errorCode`. */
export function failureCode(error: unknown): { code: string; params: UserErrorParams } | null {
  if (error instanceof UserError) {
    return { code: error.code, params: error.params };
  }
  if (!error || typeof error !== "object") {
    return null;
  }
  const failure = (error as { failure?: { code?: unknown } }).failure;
  if (typeof failure?.code === "string") {
    return { code: failure.code, params: {} };
  }

  // Any other Error's `code` is a system's (ENOENT, ENOSPC), never a catalog key.
  if (error instanceof Error) {
    return null;
  }

  // A record's `errorCode` names its failure; a bare `code` is a reply body's.
  const { errorCode, errorParams, code, params } = error as {
    errorCode?: unknown;
    errorParams?: unknown;
    code?: unknown;
    params?: unknown;
  };
  if (typeof errorCode === "string") {
    return { code: errorCode, params: isParams(errorParams) ? errorParams : {} };
  }
  return typeof code === "string" ? { code, params: isParams(params) ? params : {} } : null;
}

/** The English of a failure, whatever carried it: an Error, a string, a
 * reply body's or record's `error`. Empty when there is none. */
export function failureText(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  if (typeof error === "string") {
    return error;
  }
  const text = (error as { error?: unknown } | null)?.error;
  return typeof text === "string" ? text : "";
}

/** The reply body for a failure. A coded failure keeps its code; an Error
 * with words of its own (an upstream tool's) keeps them; anything else
 * answers with `fallback`.
 *
 *   Response.json(errorBody(e, new UserError("export_start_failed", "Export failed to start.")), { status: 500 })
 */
export function errorBody(failure: unknown, fallback: UserError | string): ErrorBody {
  const coded = failureCode(failure);
  const text = failureText(failure);
  if (coded && text) {
    return { error: text, code: coded.code, params: coded.params };
  }
  if (text) {
    return { error: text };
  }
  return typeof fallback === "string" ? { error: fallback } : errorBody(fallback, fallback.message);
}

/** The record fields for a failure, the way errorBody words it. */
export function errorFields(failure: unknown, fallback: UserError | string): Required<Pick<ErrorFields, "error">> & ErrorFields {
  const body = errorBody(failure, fallback);
  return {
    error: body.error,
    ...(body.code ? { errorCode: body.code, errorParams: body.params ?? {} } : {}),
  };
}

/** The failure a reply body or record carried, rebuilt for the page: a
 * UserError when it has a code, its own words when it has only those, and
 * `fallback` when it carried nothing.
 *
 *   if (!res.ok) throw errorFromBody(await res.json().catch(() => null), new UserError("folder_create_failed", "Could not create folder."));
 */
export function errorFromBody(body: unknown, fallback: UserError | string): Error {
  const text = failureText(body);
  if (!text) {
    return typeof fallback === "string" ? new Error(fallback) : fallback;
  }
  const coded = failureCode(body);
  return coded ? new UserError(coded.code, text, coded.params) : new Error(text);
}

const PAYMENT_REQUIRED = 402;
const PAYLOAD_TOO_LARGE = 413;

/** The failure a reply that came back not ok carried. A credits or storage
 * wall answers with its code under `error` (`{ error: "storage_quota_exceeded" }`),
 * so it reads as the wall's own failure, in the reply's own `message` when it
 * sent one; any other reply as errorFromBody.
 *
 *   if (!res.ok) throw replyError(res.status, body, new UserError("project_duplicate_failed", "Could not duplicate the project."));
 */
export function replyError(status: number, body: unknown, fallback: UserError | string): Error {
  if (status === PAYMENT_REQUIRED || status === PAYLOAD_TOO_LARGE) {
    const wall = operationFailure(status, body);
    if (wall) {
      const own = (body as { message?: unknown } | null)?.message;
      return new UserError(wall.code, typeof own === "string" && own ? own : wall.message);
    }
  }
  return errorFromBody(body, fallback);
}
