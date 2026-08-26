import {
  emailFrom,
  getResend,
  isResendConfigured,
  type EmailUser,
} from "@/lib/email/resend";
import { isMarketingUnsubscribed, unsubscribePageUrl } from "@/lib/email/unsubscribe";
import { outreachReplyAddress } from "@/lib/marketing/replyAddress";
import {
  fillOutreachText,
  UnknownPlaceholderError,
  type OutreachVars,
} from "@/lib/marketing/placeholders";

export class OutreachNotSendableError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = "OutreachNotSendableError";
  }
}

type SendOutreachInput = {
  user: EmailUser;
  outreachId: string;
  // Which send this is for the row, so a retried click cannot double-send and
  // a deliberate second note still goes out.
  attempt: number;
  // The final words, from a template or typed in the dialog. Placeholders are
  // filled here so the operator edits `{{firstName}}` and the recipient reads
  // their name.
  subject: string;
  body: string;
  vars: OutreachVars;
};

// One person writing to one person, so the message goes out as text/plain with
// no markup, no template shell, and no bulk-mail headers. A mail provider reads
// an HTML body or a `List-Unsubscribe` header as a mailing list and files the
// note under promotions; the opt-out still rides along as a line of text and
// the send still checks it first.
function outreachText(body: string, unsubscribeUrl: string): string {
  return `${body.trim()}\n\n--\nUnsubscribe from product emails: ${unsubscribeUrl}\n`;
}

// Sends one outreach note. The reply-to is the row's own address: a reply comes
// back through Resend Inbound and finds its row without matching on the sender.
export async function sendOutreachEmail({
  attempt,
  body,
  outreachId,
  subject,
  user,
  vars,
}: SendOutreachInput): Promise<void> {
  if (!isResendConfigured()) {
    throw new OutreachNotSendableError("RESEND_API_KEY is not configured.");
  }
  const from = emailFrom();
  if (!from) {
    throw new OutreachNotSendableError("RESEND_FROM_EMAIL is not configured.");
  }
  if (await isMarketingUnsubscribed(user.id)) {
    throw new OutreachNotSendableError("That account is unsubscribed.");
  }

  let filledSubject: string;
  let filledBody: string;
  try {
    filledSubject = fillOutreachText(subject, vars);
    filledBody = fillOutreachText(body, vars);
  } catch (error) {
    if (error instanceof UnknownPlaceholderError) {
      throw new OutreachNotSendableError(error.message);
    }
    throw error;
  }

  const { error } = await getResend().emails.send(
    {
      from,
      to: user.email,
      replyTo: outreachReplyAddress(outreachId),
      subject: filledSubject,
      text: outreachText(filledBody, unsubscribePageUrl(user.id)),
    },
    { idempotencyKey: `outreach:${outreachId}:${attempt}` },
  );
  if (error) {
    throw new Error(`Resend send failed: ${error.name}: ${error.message}`);
  }
}
