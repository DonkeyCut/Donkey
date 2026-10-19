import { DONKEYCUT_CANONICAL } from "@/cut/lib/hosts";
import { metaBrowser, trackMetaEvent } from "@/lib/meta/conversions";

// A signup finishes on the auth callback, whose address names the provider;
// Meta gets the page it started on.
const SIGN_UP_PAGE = `${DONKEYCUT_CANONICAL}/sign-up`;

/** Reports a new account, matched through the browser that created it. */
export function trackSignup(user: { id: string; email: string }, headers: Headers | undefined): void {
  trackMetaEvent({
    browser: headers ? metaBrowser(headers) : {},
    id: `signup-${user.id}`,
    name: "CompleteRegistration",
    url: SIGN_UP_PAGE,
    user,
  });
}
