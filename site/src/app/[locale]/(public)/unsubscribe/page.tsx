import { getTranslations } from "next-intl/server";
import { Suspense } from "react";

import { LegalPageShell } from "@/app/legal/LegalPageShell";
import { UnsubscribeConfirm } from "@/app/[locale]/(public)/unsubscribe/UnsubscribeConfirm";
import { verifyUnsubscribeToken } from "@/lib/email/unsubscribe";

// Where the unsubscribe link in an email footer lands. The token is verified
// here, but the actual unsubscribe waits for a button press: link-prefetching
// mail scanners open URLs on the recipient's behalf, and a GET that
// unsubscribed on load would let them opt people out.
//
// The token is request data, so the shell — page chrome and heading — prerenders
// and the verified answer streams in behind the boundary below.
export default async function UnsubscribePage({
  searchParams,
}: {
  searchParams: Promise<{ token?: string }>;
}) {
  const t = await getTranslations("legal.unsubscribe");
  return (
    <LegalPageShell content="page">
      <h1>{t("title")}</h1>
      <Suspense fallback={<p>{t("checking")}</p>}>
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
  const [{ token }, t] = await Promise.all([searchParams, getTranslations("legal.unsubscribe")]);
  const userId = token ? verifyUnsubscribeToken(token) : null;

  if (!userId || !token) {
    return <p>{t("invalid")}</p>;
  }
  return <UnsubscribeConfirm token={token} />;
}
