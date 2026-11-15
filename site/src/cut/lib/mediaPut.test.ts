import { afterEach, expect, spyOn, test } from "bun:test";

import { putSigned } from "./media";
import { ConnectionLostError } from "./network";
import { UserError } from "./userError";

const restores: (() => void)[] = [];

afterEach(() => {
  for (const restore of restores.splice(0)) restore();
});

/** A stand-in XHR whose send ends the way `outcome` says, after reporting
 * `sent` bytes of upload progress. */
function fakeXhr(outcome: { status: number; body?: string } | "dropped", sent = 0) {
  class FakeXhr {
    status = 0;
    responseText = "";
    upload: { onprogress?: (e: { lengthComputable: boolean; loaded: number; total: number }) => void } = {};
    onload?: () => void;
    onerror?: () => void;
    onabort?: () => void;
    open() {}
    setRequestHeader() {}
    abort() {}
    send(body: Blob) {
      queueMicrotask(() => {
        this.upload.onprogress?.({ lengthComputable: true, loaded: sent, total: body.size });
        if (outcome === "dropped") {
          this.onerror?.();
          return;
        }
        this.status = outcome.status;
        this.responseText = outcome.body ?? "";
        this.onload?.();
      });
    }
  }
  const had = "XMLHttpRequest" in globalThis;
  const before = (globalThis as { XMLHttpRequest?: unknown }).XMLHttpRequest;
  (globalThis as { XMLHttpRequest?: unknown }).XMLHttpRequest = FakeXhr;
  restores.push(() => {
    if (had) (globalThis as { XMLHttpRequest?: unknown }).XMLHttpRequest = before;
    else delete (globalThis as { XMLHttpRequest?: unknown }).XMLHttpRequest;
  });
}

const R2_REFUSAL = "<?xml version=\"1.0\"?><Error><Code>SignatureDoesNotMatch</Code><Message>no</Message></Error>";

test("a refused upload names the status and the storage's error code", async () => {
  fakeXhr({ status: 403, body: R2_REFUSAL });
  const err = await putSigned("https://r2.example/put", new Blob(["video"]), "video/mp4").catch((e) => e);

  expect(err instanceof UserError).toBe(true);
  expect(err.code).toBe("upload_failed");
  expect(String(err.cause?.message)).toContain("403");
  expect(String(err.cause?.message)).toContain("SignatureDoesNotMatch");
});

test("a dropped upload of a file the browser can no longer read carries the read failure", async () => {
  fakeXhr("dropped");
  const unreadable = new DOMException("The requested file could not be read.", "NotReadableError");
  const file = new Blob(["video"]);
  spyOn(file, "slice").mockReturnValue({ arrayBuffer: () => Promise.reject(unreadable) } as unknown as Blob);
  const err = await putSigned("https://r2.example/put", file, "video/mp4").catch((e) => e);

  expect(err instanceof ConnectionLostError).toBe(true);
  expect(err.cause).toBe(unreadable);
});

test("a dropped upload of a readable file says how far it got", async () => {
  fakeXhr("dropped", 3);
  const err = await putSigned("https://r2.example/put", new Blob(["video"]), "video/mp4").catch((e) => e);

  expect(err instanceof ConnectionLostError).toBe(true);
  expect(String(err.cause?.message)).toContain("3 of 5 bytes");
});

test("a refused upload without XHR names the status too", async () => {
  const fetched = spyOn(globalThis, "fetch").mockResolvedValue(new Response(R2_REFUSAL, { status: 403 }));
  restores.push(() => fetched.mockRestore());
  const err = await putSigned("https://r2.example/put", new Blob(["video"]), "video/mp4").catch((e) => e);

  expect(err.code).toBe("upload_failed");
  expect(String(err.cause?.message)).toContain("403");
  expect(String(err.cause?.message)).toContain("SignatureDoesNotMatch");
});
