import type { Locale } from "@/i18n/locales";
import type { Messages } from "@/i18n/namespaces";

declare module "use-intl" {
  interface AppConfig {
    Locale: Locale;
    Messages: Messages;
  }
}
