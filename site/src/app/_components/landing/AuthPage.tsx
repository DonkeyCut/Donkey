import { Suspense } from "react";
import { AuthScreen } from "@/app/_components/landing/AuthScreen";
import { CutFooter } from "@/app/cut/_components/landing/CutFooter";

export type AuthSearchParams = Promise<{
  method?: string | string[];
  callbackURL?: string | string[];
}>;

type Props = { mode: "sign-in" | "sign-up"; searchParams: AuthSearchParams };

async function Form({ mode, searchParams }: Props) {
  const { method, callbackURL } = await searchParams;
  return <AuthScreen mode={mode} method={method === "email" ? "email" : "google"}
    callbackURL={typeof callbackURL === "string" ? callbackURL : undefined} footer={<CutFooter />} />;
}

export function AuthPage(props: Props) {
  return <Suspense fallback={<AuthScreen mode={props.mode} footer={<CutFooter />} />}>
    <Form {...props} />
  </Suspense>;
}
