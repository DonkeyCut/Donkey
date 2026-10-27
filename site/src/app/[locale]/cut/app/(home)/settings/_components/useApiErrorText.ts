"use client";

import { useTranslations } from "next-intl";

import { ApiError } from "@/queries/apiClient";

type ApiErrorParams = Record<string, string | number>;

/**
 * Words a failed settings request for the reader. A route's error code that
 * the `common.apiErrors` catalog knows reads in the page's language; any other
 * failure reads as the card's own `fallback` line.
 */
export function useApiErrorText(): (error: unknown, fallback: string, params?: ApiErrorParams) => string {
  const t = useTranslations("common.apiErrors");
  return (error, fallback, params) => {
    if (!(error instanceof ApiError) || !error.code) {
      return fallback;
    }
    const key = error.code as Parameters<typeof t.has>[0];
    return t.has(key) ? t(key, params) : fallback;
  };
}
