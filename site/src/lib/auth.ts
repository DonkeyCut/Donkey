import { betterAuth } from "better-auth";
import { prismaAdapter } from "better-auth/adapters/prisma";
import { bearer } from "better-auth/plugins";

import { DONKEYCUT_CANONICAL } from "@/cut/lib/hosts";
import { provisionSignupGrants } from "@/lib/onboarding/signup-grants";
import { prisma } from "@/lib/prisma";

// donkeycut.com is the single production host: the sign-in pages, the auth
// API, the Google OAuth callback, and the session all live on that one origin
// (the proxy 308s www. to the apex before anything serves), so auth cookies
// stay plain host-only cookies. Hosted deploys pin baseURL there — it decides
// the OAuth redirect_uri — while local dev leaves it unset and better-auth
// derives it from the localhost request.
const baseURL = process.env.VERCEL ? DONKEYCUT_CANONICAL : undefined;

// The iOS app signs in natively and exchanges the provider's ID token for a
// session at /api/auth/sign-in/social. ID tokens are verified against these
// native OAuth clients alongside the web client. The Google iOS client id is
// deployment-specific, so it rides the environment (GOOGLE_IOS_CLIENT_ID)
// with the other Google OAuth values.
const IOS_APP_BUNDLE_ID = "com.donkeycut.donkeycut";
const APPLE_SERVICES_ID = "com.donkeycut.signin";

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
        // Every new account is provisioned with its signup credit grant, its
        // starter project, the welcome email, and its Resend contact.
        // provisionSignupGrants is idempotent and
        // swallows its own errors, so it never blocks user creation.
        after: async (user) => {
          await provisionSignupGrants({
            email: user.email,
            id: user.id,
            name: user.name,
          });
        },
      },
    },
  },
  emailAndPassword: {
    enabled: false,
  },
  socialProviders: {
    google: {
      // The first entry drives the web OAuth flow; the rest are accepted
      // audiences for native ID-token sign-in.
      clientId: [
        process.env.GOOGLE_CLIENT_ID,
        process.env.GOOGLE_IOS_CLIENT_ID,
      ].filter((id): id is string => !!id),
      clientSecret: process.env.GOOGLE_CLIENT_SECRET ?? "",
      // Always show Google's account chooser: without this, a browser with one
      // signed-in Google session silently reuses the last-used account.
      prompt: "select_account",
    },
    apple: {
      clientId: APPLE_SERVICES_ID,
      clientSecret: process.env.APPLE_CLIENT_SECRET ?? "",
      // Native Sign in with Apple mints tokens whose audience is the app's
      // bundle id.
      appBundleIdentifier: IOS_APP_BUNDLE_ID,
    },
  },
  // The iOS app holds its session as a bearer token (`set-auth-token`
  // response header, then `Authorization: Bearer` on every call).
  plugins: [bearer()],
});
