import type { ReactNode } from "react";
import { NextIntlClientProvider } from "next-intl";

import auth from "@/i18n/messages/en/auth.json";
import billing from "@/i18n/messages/en/billing.json";
import chat from "@/i18n/messages/en/chat.json";
import chatgpt from "@/i18n/messages/en/chatgpt.json";
import common from "@/i18n/messages/en/common.json";
import editor from "@/i18n/messages/en/editor.json";
import errors from "@/i18n/messages/en/errors.json";
import home from "@/i18n/messages/en/home.json";
import inspector from "@/i18n/messages/en/inspector.json";
import install from "@/i18n/messages/en/install.json";
import labels from "@/i18n/messages/en/labels.json";
import landing from "@/i18n/messages/en/landing.json";
import legal from "@/i18n/messages/en/legal.json";
import media from "@/i18n/messages/en/media.json";
import mock from "@/i18n/messages/en/mock.json";
import onboarding from "@/i18n/messages/en/onboarding.json";
import panels from "@/i18n/messages/en/panels.json";
import settings from "@/i18n/messages/en/settings.json";
import share from "@/i18n/messages/en/share.json";
import timeline from "@/i18n/messages/en/timeline.json";
import type { Messages } from "@/i18n/namespaces";

// The whole English catalog, loaded synchronously for tests that render
// components outside a page.
export const EN_MESSAGES: Messages = {
  auth,
  billing,
  chat,
  chatgpt,
  common,
  editor,
  errors,
  home,
  inspector,
  install,
  labels,
  landing,
  legal,
  media,
  mock,
  onboarding,
  panels,
  settings,
  share,
  timeline,
};

/** Wraps a tree in the English catalog, the way a page's IntlScope does. */
export function WithIntl({ children }: { children: ReactNode }) {
  return (
    <NextIntlClientProvider locale="en" messages={EN_MESSAGES} timeZone="UTC">
      {children}
    </NextIntlClientProvider>
  );
}
