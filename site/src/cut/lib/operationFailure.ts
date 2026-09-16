/** JSON-safe failures shared by transports, headless commands, and host UIs. */
export type OperationFailure = {
  code: "storage_quota_exceeded" | "insufficient_credits" | "insufficient_credits_for_generation" | "authentication_required";
  message: string;
  bytes?: number;
  quotaBytes?: number;
};

export function operationFailure(status: number, body: unknown): OperationFailure | null {
  const data = body && typeof body === "object" ? body as Record<string, unknown> : {};
  if (status === 401) return { code: "authentication_required", message: "Sign in to continue." };
  if (status === 413 && data.error === "storage_quota_exceeded") {
    return {
      code: "storage_quota_exceeded", message: "Cloud storage is full.",
      ...(typeof data.bytes === "number" ? { bytes: data.bytes } : {}),
      ...(typeof data.quotaBytes === "number" ? { quotaBytes: data.quotaBytes } : {}),
    };
  }
  if (status === 402) return {
    code: data.error === "insufficient_credits_for_generation"
      ? "insufficient_credits_for_generation" : "insufficient_credits",
    message: "There are not enough AI credits for this operation.",
  };
  return null;
}

export class OperationError extends Error {
  constructor(readonly failure: OperationFailure) {
    super(failure.message);
    this.name = "OperationError";
  }
}

const listeners = new Set<(failure: OperationFailure) => void>();
export function onOperationFailure(listener: (failure: OperationFailure) => void): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

/** Hosts opt into presentation. Reading a response never consumes its body. */
export async function observeOperationResponse(response: Response): Promise<Response> {
  if (![401, 402, 413].includes(response.status)) return response;
  const failure = operationFailure(response.status, await response.clone().json().catch(() => null));
  if (failure) for (const listener of listeners) listener(failure);
  return response;
}
