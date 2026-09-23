import { APIError, createAuthMiddleware } from "better-auth/api";

export const emailPasswordOptions = {
  enabled: true,
};

// Password recovery needs an email delivery flow before it can be exposed.
export const emailPasswordDisabledPaths = [
  "/set-password",
  "/request-password-reset",
  "/reset-password",
];

export const emailPasswordGuard = createAuthMiddleware(async (ctx) => {
  if (ctx.path !== "/sign-in/email" && ctx.path !== "/sign-up/email") return;
  const callback: unknown = ctx.body?.callbackURL;
  if (callback !== undefined && (
    typeof callback !== "string" ||
    !URL.canParse(callback, ctx.context.baseURL) ||
    new URL(callback, ctx.context.baseURL).origin !== new URL(ctx.context.baseURL).origin
  )) {
    throw new APIError("FORBIDDEN", { message: "Invalid callback URL" });
  }
});
