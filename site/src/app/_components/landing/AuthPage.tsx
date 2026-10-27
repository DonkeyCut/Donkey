import { cookies, headers } from "next/headers";
import { redirect } from "next/navigation";
import { Suspense } from "react";
import { AuthScreen } from "@/app/_components/landing/AuthScreen";
import { CutFooter } from "@/app/[locale]/cut/_components/landing/CutFooter";
import { auth } from "@/lib/auth";
import { resumeAfterAuthError, SIGN_IN_RETURN_COOKIE, signInReturnPath } from "@/lib/signInReturn";

export type AuthSearchParams = Promise<{
  method?: string | string[];
  callbackURL?: string | string[];
  error?: string | string[];
}>;

type Props = { mode: "sign-in" | "sign-up"; searchParams: AuthSearchParams };

async function Form({ mode, searchParams }: Props) {
  const { method, callbackURL, error } = await searchParams;
  const authError = typeof error === "string" ? error : undefined;

  // A sign-in URL without its callback (a new tab mid-authorization) still
  // returns to the authorization that sent this browser here.
  const remembered = (await cookies()).get(SIGN_IN_RETURN_COOKIE)?.value;
  const returnPath = signInReturnPath(typeof callbackURL === "string" ? callbackURL : undefined, remembered);

  // A failed callback from a visitor who already holds a session (a replayed
  // redirect) continues on; anyone else sees the error and tries again.
  if (authError) {
    const session = (await auth.api.getSession({ headers: await headers() })) ? "signed-in" : "signed-out";
    const resume = resumeAfterAuthError(authError, session, returnPath);
    if (resume) {
      redirect(resume);
    }
  }

  return <AuthScreen mode={mode} method={method === "email" ? "email" : "google"}
    callbackURL={returnPath} authError={authError} footer={<CutFooter />} />;
}

export function AuthPage(props: Props) {
  return <Suspense fallback={<AuthScreen mode={props.mode} footer={<CutFooter />} />}>
    <Form {...props} />
  </Suspense>;
}
