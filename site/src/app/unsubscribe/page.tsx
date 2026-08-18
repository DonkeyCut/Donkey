import { Suspense } from "react";

import { LegalPageShell } from "@/app/legal/LegalPageShell";
import { UnsubscribeConfirm } from "@/app/unsubscribe/UnsubscribeConfirm";
import { verifyUnsubscribeToken } from "@/lib/email/unsubscribe";

// Where the unsubscribe link in an email footer lands. The token is verified
// here, but the actual unsubscribe waits for a button press: link-prefetching
// mail scanners open URLs on the recipient's behalf, and a GET that
// unsubscribed on load would let them opt people out.
//
// The token is request data, so the shell — page chrome and heading — prerenders
// and the verified answer streams in behind the boundary below.
export default function UnsubscribePage({
  searchParams,
}: {
  searchParams: Promise<{ token?: string }>;
}) {
  return (
    <LegalPageShell>
      <h1>Email preferences</h1>
      <Suspense fallback={<p>Checking this link…</p>}>
        <Verdict searchParams={searchParams} />
      </Suspense>
    </LegalPageShell>
  );
}

async function Verdict({
  searchParams,
}: {
  searchParams: Promise<{ token?: string }>;
}) {
  const { token } = await searchParams;
  const userId = token ? verifyUnsubscribeToken(token) : null;

  if (!userId || !token) {
    return (
      <p>
        This link is no longer valid. You can manage product emails from Settings
        in the app.
      </p>
    );
  }
  return <UnsubscribeConfirm token={token} />;
}
