"use client";

import { useTranslations } from "next-intl";
import { useState, type FormEvent } from "react";
import { authClient } from "@/lib/auth-client";

type Props = { mode: "sign-in" | "sign-up"; callbackURL?: string };

// Better Auth answers a throttled request with no code, only this status.
const HTTP_TOO_MANY_REQUESTS = 429;

type AuthFailure = { code?: string; message?: string; status?: number };

export function EmailAuthForm({ mode, callbackURL }: Props) {
  const t = useTranslations("auth");
  const signingUp = mode === "sign-up";

  // Better Auth names each failure with a code; a code the catalog knows reads
  // in the page's language, anything else reads as the server worded it.
  const describe = (failure: AuthFailure): string => {
    const key = `errors.${failure.code}` as Parameters<typeof t>[0];
    if (failure.code && t.has(key)) {
      return t(key);
    }
    if (failure.status === HTTP_TOO_MANY_REQUESTS) {
      return t("form.tooManyRequests");
    }
    return failure.message ?? t("form.checkDetails");
  };
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    setPending(true);
    setError(null);
    try {
      const credentials = {
        email: String(data.get("email")),
        password: String(data.get("password")),
        callbackURL: callbackURL ?? (signingUp ? "/app/onboarding" : "/app"),
      };
      const result = signingUp
        ? await authClient.signUp.email({ ...credentials, name: String(data.get("name")) })
        : await authClient.signIn.email(credentials);
      if (result.error) {
        setError(describe(result.error));
      } else if (signingUp) {
        // OAuth callbacks can be non-React endpoints, so complete signup with a full navigation.
        window.location.href = credentials.callbackURL;
      }
    } catch {
      setError(t("form.requestFailed"));
    } finally {
      setPending(false);
    }
  }

  return (
    <form onSubmit={submit} className="flex w-80 max-w-full flex-col gap-3 text-left">
      {signingUp ? <label className="flex flex-col gap-1 text-sm">
        {t("form.name")}
        <input name="name" autoComplete="name" required disabled={pending}
          className="rounded-lg border border-input bg-card text-card-foreground px-3 py-2 outline-none focus:border-foreground focus:ring-1 focus:ring-inset focus:ring-foreground" />
      </label> : null}
      <label className="flex flex-col gap-1 text-sm">
        {t("form.email")}
        <input name="email" type="email" autoComplete="username" required disabled={pending}
          className="rounded-lg border border-input bg-card text-card-foreground px-3 py-2 outline-none focus:border-foreground focus:ring-1 focus:ring-inset focus:ring-foreground" />
      </label>
      <label className="flex flex-col gap-1 text-sm">
        {t("form.password")}
        <input name="password" type="password" autoComplete={signingUp ? "new-password" : "current-password"} required disabled={pending}
          className="rounded-lg border border-input bg-card text-card-foreground px-3 py-2 outline-none focus:border-foreground focus:ring-1 focus:ring-inset focus:ring-foreground" />
      </label>
      <button type="submit" disabled={pending}
        className="rounded-lg bg-primary px-4 py-2 text-primary-foreground disabled:opacity-60">
        {pending ? t("form.pleaseWait") : signingUp ? t("form.createAccount") : t("form.signIn")}
      </button>
      {error ? <p role="alert" className="text-sm">{error}</p> : null}
    </form>
  );
}
