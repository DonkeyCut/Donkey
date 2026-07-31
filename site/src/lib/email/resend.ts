import { Resend } from "resend";

// The sending identity, in "Name <address@domain>" form. Env rather than code
// so the open-source repo carries no personal address. Empty skips sends.
export function emailFrom(): string {
  return process.env.RESEND_FROM_EMAIL ?? "";
}

// The Resend segment every account joins at signup, so broadcasts have one
// list to target: Segments → "Registered Users" in the dashboard. Empty skips
// the segment step — contacts are still created.
export function registeredUsersSegmentId(): string {
  return process.env.RESEND_REGISTERED_USERS_SEGMENT_ID ?? "";
}

// What every email path needs to know about an account.
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
