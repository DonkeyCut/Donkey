import { cookies } from "next/headers";
import { Suspense } from "react";
import { AuthScreen } from "@/app/_components/landing/AuthScreen";
import { CutFooter } from "@/app/cut/_components/landing/CutFooter";
import { SIGN_IN_RETURN_COOKIE, signInReturnPath } from "@/lib/signInReturn";

export type AuthSearchParams = Promise<{
  method?: string | string[];
  callbackURL?: string | string[];
}>;

type Props = { mode: "sign-in" | "sign-up"; searchParams: AuthSearchParams };

async function Form({ mode, searchParams }: Props) {
  const { method, callbackURL } = await searchParams;

  // A sign-in URL without its callback (a new tab mid-authorization) still
  // returns to the authorization that sent this browser here.
  const remembered = (await cookies()).get(SIGN_IN_RETURN_COOKIE)?.value;
  const returnPath = signInReturnPath(typeof callbackURL === "string" ? callbackURL : undefined, remembered);
  return <AuthScreen mode={mode} method={method === "email" ? "email" : "google"}
    callbackURL={returnPath} footer={<CutFooter />} />;
}

export function AuthPage(props: Props) {
  return <Suspense fallback={<AuthScreen mode={props.mode} footer={<CutFooter />} />}>
    <Form {...props} />
  </Suspense>;
}
