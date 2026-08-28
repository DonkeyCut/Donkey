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
  // Whether the note carries the opt-out footer. The operator decides per
  // send; the unsubscribed check above the send always runs.
  unsubscribeLink: boolean;
  // Whether replies route through the row's signed alias, which forwards them
  // to the operator's inbox and marks the row replied. Off puts the sending
  // address itself on the wire, so the note reads like any personal thread and
  // the row is filed with the list's "Mark replied" button.
  trackReplies: boolean;
};

// One person writing to one person, so the message goes out as text/plain with
// no markup, no template shell, and no bulk-mail headers. A mail provider reads
// an HTML body or a `List-Unsubscribe` header as a mailing list and files the
// note under promotions. When the operator turns the opt-out footer on, it
// rides along as a line of text.
function outreachText(body: string, unsubscribeUrl: string | null): string {
  const trimmed = body.trim();
  if (!unsubscribeUrl) return `${trimmed}\n`;
  return `${trimmed}\n\n--\nUnsubscribe from product emails: ${unsubscribeUrl}\n`;
}

// Sends one outreach note. The reply target is the operator's call per send:
// the row's own signed alias, or the sending address itself.
export async function sendOutreachEmail({
  attempt,
  body,
  outreachId,
  subject,
  trackReplies,
  unsubscribeLink,
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
      replyTo: trackReplies ? outreachReplyAddress(outreachId) : undefined,
      subject: filledSubject,
      text: outreachText(
        filledBody,
        unsubscribeLink ? unsubscribePageUrl(user.id) : null,
      ),
    },
    { idempotencyKey: `outreach:${outreachId}:${attempt}` },
  );
  if (error) {
    throw new Error(`Resend send failed: ${error.name}: ${error.message}`);
  }
}
