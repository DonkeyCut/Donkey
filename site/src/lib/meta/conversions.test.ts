import { expect, test } from "bun:test";

import { metaBrowser } from "./conversions";

test("the browser reads from cookies and forwarding headers", () => {
  const headers = new Headers({
    cookie: "session=x; _fbp=fb.1.1.42; _fbc=fb.1.2.click",
    "user-agent": "Mozilla/5.0",
    "x-forwarded-for": "203.0.113.7, 10.0.0.1",
  });
  expect(metaBrowser(headers)).toEqual({
    fbc: "fb.1.2.click",
    fbp: "fb.1.1.42",
    ip: "203.0.113.7",
    userAgent: "Mozilla/5.0",
  });
});

test("an address that is not one stays off the event", () => {
  expect(metaBrowser(new Headers({ "x-forwarded-for": "unknown" })).ip).toBeUndefined();
});
