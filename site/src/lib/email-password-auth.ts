import { APIError, createAuthMiddleware, getSessionFromCtx } from "better-auth/api";

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
  if (ctx.path === "/send-verification-email") {
    const session = await getSessionFromCtx(ctx);
    if (!session || typeof ctx.body?.email !== "string" || ctx.body.email.toLowerCase() !== session.user.email.toLowerCase()) {
      throw new APIError("UNAUTHORIZED", { message: "Sign in to verify your email." });
    }
  }
  if (ctx.path !== "/sign-in/email" && ctx.path !== "/sign-up/email" && ctx.path !== "/send-verification-email") return;
  const callback: unknown = ctx.body?.callbackURL;
  if (callback !== undefined && (
    typeof callback !== "string" ||
    !URL.canParse(callback, ctx.context.baseURL) ||
    new URL(callback, ctx.context.baseURL).origin !== new URL(ctx.context.baseURL).origin
  )) {
    throw new APIError("FORBIDDEN", { message: "Invalid callback URL" });
  }
});
