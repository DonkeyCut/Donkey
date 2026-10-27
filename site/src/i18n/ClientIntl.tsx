"use client";

import type { ReactNode } from "react";
import { NextIntlClientProvider, type AbstractIntlMessages } from "next-intl";

import type { Locale } from "@/i18n/locales";

// Times show in the reader's own zone. The server renders in its zone, so a
// date drawn into a prerendered shell would differ from the page's; the
// app's dates all arrive with its data, after hydration.
const READER_TIME_ZONE = Intl.DateTimeFormat().resolvedOptions().timeZone;

/** The client half of IntlScope. */
export function ClientIntl({
  locale,
  messages,
  children,
}: {
  locale: Locale;
  messages: AbstractIntlMessages;
  children: ReactNode;
}) {
  return (
    <NextIntlClientProvider locale={locale} messages={messages} timeZone={READER_TIME_ZONE}>
      {children}
    </NextIntlClientProvider>
  );
}
