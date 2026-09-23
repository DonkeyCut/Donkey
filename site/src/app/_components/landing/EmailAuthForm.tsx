"use client";

import { useState, type FormEvent } from "react";
import { authClient } from "@/lib/auth-client";

type Props = { mode: "sign-in" | "sign-up" };

export function EmailAuthForm({ mode }: Props) {
  const signingUp = mode === "sign-up";
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
        callbackURL: new URLSearchParams(window.location.search).get("callbackURL") ?? (signingUp ? "/app/onboarding" : "/app"),
      };
      const result = signingUp
        ? await authClient.signUp.email({ ...credentials, name: String(data.get("name")) })
        : await authClient.signIn.email(credentials);
      if (result.error) {
        setError(result.error.message ?? "Check your details and try again.");
      } else if (signingUp) {
        // OAuth callbacks can be non-React endpoints, so complete signup with a full navigation.
        window.location.href = credentials.callbackURL;
      }
    } catch {
      setError("Could not complete your request. Please try again.");
    } finally {
      setPending(false);
    }
  }

  return (
    <form onSubmit={submit} className="flex w-80 max-w-full flex-col gap-3 text-left">
      {signingUp ? <label className="flex flex-col gap-1 text-sm">
        Name
        <input name="name" autoComplete="name" required disabled={pending}
          className="rounded-lg border border-ink/30 bg-white px-3 py-2 outline-none focus:border-ink focus:ring-1 focus:ring-inset focus:ring-ink" />
      </label> : null}
      <label className="flex flex-col gap-1 text-sm">
        Email
        <input name="email" type="email" autoComplete="username" required disabled={pending}
          className="rounded-lg border border-ink/30 bg-white px-3 py-2 outline-none focus:border-ink focus:ring-1 focus:ring-inset focus:ring-ink" />
      </label>
      <label className="flex flex-col gap-1 text-sm">
        Password
        <input name="password" type="password" autoComplete={signingUp ? "new-password" : "current-password"} required disabled={pending}
          className="rounded-lg border border-ink/30 bg-white px-3 py-2 outline-none focus:border-ink focus:ring-1 focus:ring-inset focus:ring-ink" />
      </label>
      <button type="submit" disabled={pending}
        className="rounded-lg bg-ink px-4 py-2 text-background disabled:opacity-60">
        {pending ? "Please wait…" : signingUp ? "Create account" : "Sign in"}
      </button>
      {error ? <p role="alert" className="text-sm">{error}</p> : null}
    </form>
  );
}
