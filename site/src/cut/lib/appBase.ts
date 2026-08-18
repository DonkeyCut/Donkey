// The Cut app's routes live under /cut/app/*; the proxy rewrite (src/proxy.ts)
// serves them at "/app/…" on every host, so that is the base every in-app href
// is built on. It sits in its own module so server components can read it too.
export const CUT_APP_BASE = "/app";
