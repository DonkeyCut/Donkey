import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from "react";
import { IntlProvider } from "use-intl";
import de from "@/i18n/messages/de/chatgpt.json";
import en from "@/i18n/messages/en/chatgpt.json";
import es from "@/i18n/messages/es/chatgpt.json";
import fr from "@/i18n/messages/fr/chatgpt.json";
import ja from "@/i18n/messages/ja/chatgpt.json";
import ko from "@/i18n/messages/ko/chatgpt.json";
import ptBR from "@/i18n/messages/pt-BR/chatgpt.json";
import zhCN from "@/i18n/messages/zh-CN/chatgpt.json";
import { DEFAULT_LOCALE, LOCALES, type Locale } from "@/i18n/locales";
import type { Messages } from "@/i18n/namespaces";

// The widget is its own bundle with no Next provider, so it carries every
// language's (small) chatgpt catalog and draws in the one ChatGPT names.
const CATALOGS: Record<Locale, Messages["chatgpt"]> = {
  en,
  es: es as Messages["chatgpt"],
  "pt-BR": ptBR as Messages["chatgpt"],
  fr: fr as Messages["chatgpt"],
  de: de as Messages["chatgpt"],
  ja: ja as Messages["chatgpt"],
  ko: ko as Messages["chatgpt"],
  "zh-CN": zhCN as Messages["chatgpt"],
};

const MESSAGES = Object.fromEntries(
  Object.entries(CATALOGS).map(([locale, chatgpt]) => [locale, { chatgpt }]),
) as Record<Locale, Pick<Messages, "chatgpt">>;

const SetLocale = createContext<(tag: string) => void>(() => {});

// Each supported locale filled out to language-script-region once, so a tag
// the host sends is matched with the browser's own Intl.Locale.
const MAXIMIZED = LOCALES.map((locale) => [locale, new Intl.Locale(locale).maximize()] as const);

/**
 * The supported locale for one BCP 47 tag from the host: the same region
 * first ("en-US" is en), then the same language and script ("pt-PT" is
 * pt-BR, "zh-TW" is Traditional and falls to English). The site's
 * Accept-Language matcher would add 46 KB to this bundle for one tag.
 */
function widgetLocale(tag: string): Locale {
  let wanted: Intl.Locale;
  try {
    wanted = new Intl.Locale(tag).maximize();
  } catch {
    return DEFAULT_LOCALE;
  }

  const exact = MAXIMIZED.find(([, full]) => full.baseName === wanted.baseName);
  if (exact) {
    return exact[0];
  }
  const near = MAXIMIZED.find(([, full]) => full.language === wanted.language && full.script === wanted.script);
  return near ? near[0] : DEFAULT_LOCALE;
}

/** ChatGPT sets window.openai before the widget runs; the MCP Apps host
 * context names the locale again once the bridge connects. */
function firstLocale(): Locale {
  const openai = (window as { openai?: { locale?: unknown } }).openai;
  return widgetLocale(typeof openai?.locale === "string" ? openai.locale : navigator.language);
}

export function WidgetIntl({ children }: { children: ReactNode }) {
  const [locale, setLocale] = useState(firstLocale);

  // The page's lang follows, so the host reads and speaks it right.
  useEffect(() => {
    document.documentElement.lang = locale;
  }, [locale]);

  const choose = useCallback((tag: string) => setLocale(widgetLocale(tag)), []);
  return <SetLocale value={choose}>
    <IntlProvider locale={locale} messages={MESSAGES[locale]}>{children}</IntlProvider>
  </SetLocale>;
}

/** Switches the widget to a BCP 47 tag the host reports. */
export function useSetWidgetLocale() {
  return useContext(SetLocale);
}
