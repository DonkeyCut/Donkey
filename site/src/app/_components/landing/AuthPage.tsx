import { Suspense } from "react";
import { AuthScreen } from "@/app/_components/landing/AuthScreen";

export type AuthSearchParams = Promise<{
  method?: string | string[];
  callbackURL?: string | string[];
}>;

type Props = { mode: "sign-in" | "sign-up"; searchParams: AuthSearchParams };

async function Form({ mode, searchParams }: Props) {
  const { method, callbackURL } = await searchParams;
  return <AuthScreen mode={mode} method={method === "email" ? "email" : "google"}
    callbackURL={typeof callbackURL === "string" ? callbackURL : undefined} />;
}

export function AuthPage(props: Props) {
  return <Suspense fallback={<AuthScreen mode={props.mode} />}>
    <Form {...props} />
  </Suspense>;
}
