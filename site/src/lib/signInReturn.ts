import { CUT_APP_BASE } from "@/cut/lib/appBase";

// Where sign-in returns when the sign-in URL lost its callback, for example
// when someone opens the email form in a new tab mid-authorization.
export const SIGN_IN_RETURN_COOKIE = "__Host-donkey-sign-in-return";
const SIGN_IN_RETURN_SECONDS = 900;

/** Set-Cookie value that remembers a same-site path for sign-in, or clears it with null. */
export function signInReturnCookie(path: string | null) {
  const maxAge = path === null ? 0 : SIGN_IN_RETURN_SECONDS;
  return `${SIGN_IN_RETURN_COOKIE}=${encodeURIComponent(path ?? "")}; Max-Age=${maxAge}; Path=/; HttpOnly; Secure; SameSite=Lax`;
}

/** The path sign-in returns to: the URL's callback, else the remembered (decoded) same-site path. */
export function signInReturnPath(callbackURL: string | undefined, remembered: string | undefined) {
  if (callbackURL) {
    return callbackURL;
  }

  // Only a path on this site: "/x", never "//host" or "/\host".
  return remembered && /^\/(?![/\\])/.test(remembered) ? remembered : undefined;
}

/** Where better-auth sends a provider callback that failed, with `?error=<code>`. */
export const AUTH_ERROR_PATH = "/sign-in";

/**
 * Where a visitor who landed on sign-in with an auth error goes next, or null
 * to stay and try again.
 *
 * Most failed callbacks are replays: Back from the app returns to Google's
 * redirect, which sends a state the first sign-in already spent. That visitor
 * holds a session, so they continue where sign-in was headed.
 */
export function resumeAfterAuthError(
  error: string | undefined,
  session: "signed-in" | "signed-out",
  returnPath: string | undefined,
): string | null {
  if (!error || session === "signed-out") {
    return null;
  }

  return returnPath ?? CUT_APP_BASE;
}
