import { LegalPageShell } from "@/app/legal/LegalPageShell";
import { UnsubscribeConfirm } from "@/app/unsubscribe/UnsubscribeConfirm";
import { verifyUnsubscribeToken } from "@/lib/email/unsubscribe";

// Where the unsubscribe link in an email footer lands. The token is verified
// here, but the actual unsubscribe waits for a button press: link-prefetching
// mail scanners open URLs on the recipient's behalf, and a GET that
// unsubscribed on load would let them opt people out.
export default async function UnsubscribePage({
  searchParams,
}: {
  searchParams: Promise<{ token?: string }>;
}) {
  const { token } = await searchParams;
  const userId = token ? verifyUnsubscribeToken(token) : null;

  return (
    <LegalPageShell>
      <h1>Email preferences</h1>
      {userId && token ? (
        <UnsubscribeConfirm token={token} />
      ) : (
        <p>
          This link is no longer valid. You can manage product emails from
          Settings in the app.
        </p>
      )}
    </LegalPageShell>
  );
}
