import { apiKey } from "@better-auth/api-key";
import { betterAuth } from "better-auth";
import { prismaAdapter } from "better-auth/adapters/prisma";

import { DONKEYCUT_CANONICAL } from "@/cut/lib/hosts";
import { provisionSignupGrants } from "@/lib/onboarding/signup-grants";
import { prisma } from "@/lib/prisma";

// Prefix for issued Vision API keys. The full secret is shown to the developer
// once at creation; only a hash is stored (handled by the apiKey plugin).
export const visionApiKeyPrefix = "dk_live_";

// donkeycut.com is the single production host: the sign-in pages, the auth
// API, the Google OAuth callback, and the session all live on that one origin
// (the proxy 308s www. to the apex before anything serves), so auth cookies
// stay plain host-only cookies. Hosted deploys pin baseURL there — it decides
// the OAuth redirect_uri — while local dev leaves it unset and better-auth
// derives it from the localhost request.
const baseURL = process.env.VERCEL ? DONKEYCUT_CANONICAL : undefined;

export const auth = betterAuth({
  baseURL,
  secret: process.env.BETTER_AUTH_SECRET,
  // Sessions last a year, and the rolling expiry is refreshed daily on use, so an active user
  // effectively never has to sign in again.
  session: {
    expiresIn: 60 * 60 * 24 * 365,
    updateAge: 60 * 60 * 24,
  },
  database: prismaAdapter(prisma, {
    provider: "postgresql",
  }),
  databaseHooks: {
    user: {
      create: {
        // Every new account is provisioned with its signup grants (app credits
        // + free Vision API calls). provisionSignupGrants is idempotent and
        // swallows its own errors, so it never blocks user creation.
        after: async (user) => {
          await provisionSignupGrants(user.id);
        },
      },
    },
  },
  emailAndPassword: {
    enabled: false,
  },
  socialProviders: {
    google: {
      clientId: process.env.GOOGLE_CLIENT_ID ?? "",
      clientSecret: process.env.GOOGLE_CLIENT_SECRET ?? "",
      // Always show Google's account chooser: without this, a browser with one
      // signed-in Google session silently reuses the last-used account.
      prompt: "select_account",
    },
  },
  plugins: [
    apiKey({
      // We enforce our own monthly call quota and per-key rate limit on the
      // vision route, so the plugin's built-in rate limiting stays off.
      defaultPrefix: visionApiKeyPrefix,
      enableMetadata: true,
      rateLimit: {
        enabled: false,
      },
    }),
  ],
});
