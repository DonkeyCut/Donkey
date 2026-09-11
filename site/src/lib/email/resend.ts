import { Resend } from "resend";

// The sending identity, in "Name <address@domain>" form. Env rather than code
// so the open-source repo carries no personal address. Empty skips sends.
export function emailFrom(): string {
  return process.env.RESEND_FROM_EMAIL ?? "";
}

// Who list mail comes from: the welcome email and promotions. A mail
// provider keeps one reputation record per signing domain, so bulk sends get
// a subdomain of their own and the apex in RESEND_FROM_EMAIL stays the
// address a person writes from. Unset falls back to that shared sender, which
// puts both streams on one domain.
export function bulkFrom(): string {
  return process.env.RESEND_BULK_FROM_EMAIL || emailFrom();
}

// What every email path needs to know about an account.
/** One message as the provider takes it. */
export type EmailMessage = Parameters<Resend["emails"]["send"]>[0];

export type EmailUser = {
  id: string;
  email: string;
  name: string;
};

export class ResendNotConfiguredError extends Error {
  public constructor() {
    super("RESEND_API_KEY is not configured.");
    this.name = "ResendNotConfiguredError";
  }
}

export function isResendConfigured(): boolean {
  return Boolean(process.env.RESEND_API_KEY);
}

let cachedResend: Resend | null = null;

export function getResend(): Resend {
  const apiKey = process.env.RESEND_API_KEY;
  if (!apiKey) {
    throw new ResendNotConfiguredError();
  }
  cachedResend ??= new Resend(apiKey);
  return cachedResend;
}
