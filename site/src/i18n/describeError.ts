"use client";

import { useTranslations } from "next-intl";

import { failureCode, failureText } from "@/cut/lib/userError";

/**
 * Words a failure for the reader. A failure with a code the `errors` catalog
 * knows reads in the page's language; anything else (an upstream service's
 * own words) reads as it came, and no message at all reads as `fallback`.
 * It takes an Error, a string, or a record that carries `error` and
 * `errorCode` (a job, a tile, an upload row).
 */
export function useDescribeError(): (error: unknown, fallback?: string) => string {
  const t = useTranslations("errors");
  return (error, fallback) => {
    const coded = failureCode(error);
    if (coded && t.has(coded.code as Parameters<typeof t.has>[0])) {
      return t(coded.code as Parameters<typeof t>[0], coded.params);
    }
    return failureText(error) || fallback || t("generic");
  };
}
