import { APIError } from "better-auth/api";
import { emailFrom, getResend } from "@/lib/email/resend";
import { withEmailBudget } from "@/lib/email/send-budget";

/** Verification links expire; deliver within the transactional budget immediately. */
export async function sendVerificationEmail({
  user,
  url,
}: {
  user: { email: string };
  url: string;
}) {
  const from = emailFrom();
  if (!from)
    throw new Error("RESEND_FROM_EMAIL is required for verification emails.");
  const result = await withEmailBudget("transactional", () =>
    getResend().emails.send({
      from,
      to: user.email,
      subject: "Verify your Donkey Cut email",
      text: `Confirm your email address for your Donkey Cut account:\n\n${url}\n\nIf you did not request this email, you can ignore it.`,
    }),
  );
  if (!result || result.error) {
    throw new APIError("SERVICE_UNAVAILABLE", {
      message: "Could not send the verification email. Please try again.",
    });
  }
}
