import { expect, test } from "bun:test";
import { observeOperationResponse, onOperationFailure, operationFailure } from "./operationFailure";

test("a storage failure is data and leaves the response readable", async () => {
  const body = { error: "storage_quota_exceeded", bytes: 20, quotaBytes: 10 };
  const failures: unknown[] = [];
  const stop = onOperationFailure((failure) => failures.push(failure));
  try {
    const response = new Response(JSON.stringify(body), { status: 413 });
    expect(await observeOperationResponse(response)).toBe(response);
    expect(await response.json()).toEqual(body);
    expect(failures).toEqual([{ code: body.error, message: "Cloud storage is full.", bytes: 20, quotaBytes: 10 }]);
  } finally { stop(); }
});

test("size limits are distinct from account storage and generation credits from an empty balance", () => {
  expect(operationFailure(413, { error: "File too large." })).toBeNull();
  expect(operationFailure(402, { error: "insufficient_credits_for_generation" })?.code).toBe("insufficient_credits_for_generation");
  expect(operationFailure(402, {})?.code).toBe("insufficient_credits");
  expect(operationFailure(401, null)?.code).toBe("authentication_required");
});
