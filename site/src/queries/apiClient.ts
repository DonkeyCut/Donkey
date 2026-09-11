// Thin fetch wrapper shared by every query/mutation hook in this folder. All
// settings UI data access goes through here so it can be audited in one place.

export type ApiIssue = { path: string; message: string };

export class ApiError extends Error {
  public readonly status: number;
  public readonly code: string | null;
  // Field-level findings from a validating route, so a form can show each
  // under its own control.
  public readonly issues: ApiIssue[];

  public constructor(message: string, status: number, code: string | null, issues: ApiIssue[] = []) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.code = code;
    this.issues = issues;
  }
}

type ApiErrorBody = { error?: string; message?: string; issues?: ApiIssue[] };

export async function apiFetch<T>(
  path: string,
  init?: RequestInit,
): Promise<T> {
  const hasBody = init?.body !== undefined;
  const response = await fetch(path, {
    ...init,
    headers: {
      ...(hasBody ? { "Content-Type": "application/json" } : {}),
      ...init?.headers,
    },
  });

  if (!response.ok) {
    let body: ApiErrorBody = {};
    try {
      body = (await response.json()) as ApiErrorBody;
    } catch {
      // Non-JSON error body; fall back to status text.
    }
    throw new ApiError(
      body.message ?? body.error ?? response.statusText,
      response.status,
      body.error ?? null,
      Array.isArray(body.issues) ? body.issues : [],
    );
  }

  if (response.status === 204) {
    return undefined as T;
  }

  return (await response.json()) as T;
}
