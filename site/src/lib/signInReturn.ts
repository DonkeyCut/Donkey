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
