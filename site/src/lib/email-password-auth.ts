import { APIError, createAuthMiddleware } from "better-auth/api";

export const emailPasswordOptions = {
  enabled: true,
};

// The site sends no email, so neither password recovery nor address
// verification is offered.
export const emailPasswordDisabledPaths = [
  "/set-password",
  "/request-password-reset",
  "/reset-password",
  "/send-verification-email",
  "/verify-email",
];

// A callback lands on this site or an origin the auth config trusts, such as
// the back office on its own subdomain.
export const emailPasswordGuard = createAuthMiddleware(async (ctx) => {
  if (ctx.path !== "/sign-in/email" && ctx.path !== "/sign-up/email") return;
  const callback: unknown = ctx.body?.callbackURL;
  if (callback !== undefined && (
    typeof callback !== "string" ||
    !URL.canParse(callback, ctx.context.baseURL) ||
    !ctx.context.isTrustedOrigin(new URL(callback, ctx.context.baseURL).href)
  )) {
    throw new APIError("FORBIDDEN", { message: "Invalid callback URL" });
  }
});
