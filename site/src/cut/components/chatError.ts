"use client";

import { useTranslations } from "next-intl";

import { UserError, failureCode, failureText } from "@/cut/lib/userError";
import { useDescribeError } from "@/i18n/describeError";

/**
 * Words a failure the chat shows, through the shared describer. A provider
 * failure with no words of its own reads the chat catalog's "The request
 * failed." in their place.
 */
export function useChatError(): (error: unknown) => string {
  const t = useTranslations("chat.failures");
  const describeError = useDescribeError();
  return (error) => {
    const coded = failureCode(error);
    if (coded?.params.detail !== "") {
      return describeError(error);
    }
    return describeError(new UserError(coded.code, failureText(error), { ...coded.params, detail: t("requestFailed") }));
  };
}
