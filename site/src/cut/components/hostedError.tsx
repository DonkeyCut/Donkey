import { useTranslations } from "next-intl";

import { NO_CREDITS_MESSAGE } from "@/cut/lib/credits";
import { creditsUrl } from "@/cut/lib/generate";
import { useOutOfCredits } from "@/cut/lib/hosted";
import { failureText } from "@/cut/lib/userError";
import { openUpgrade } from "@/cut/lib/upgrade";
import { useDescribeError } from "@/i18n/describeError";

/** Opens the upgrade dialog on its credits wall. A surface without the dialog
 * (the ChatGPT card) opens the settings page, where plans are sold. */
export function openCreditsWall(): void {
  if (openUpgrade("credits")) {
    return;
  }
  window.open(creditsUrl(), "_blank", "noreferrer");
}

/** A hosted-inference failure (chat reply or generation tile): an Error, a
 * string, or a record carrying `error` and `errorCode` (a job). A balance
 * failure reads "Insufficient credits, see plans" with the link to the
 * credits wall inline; any other failure reads through the shared describer, and
 * a missing one reads `fallback`.
 * Surfaces inside the chat panel pass `link={false}` and lean on the composer's
 * credits tab for the link — but that tab only rises for an empty balance, so a
 * balance merely short of one generation keeps its link here. */
export function HostedErrorText({ error, fallback, link = true }: { error?: unknown; fallback?: string; link?: boolean }) {
  const t = useTranslations("chat.hostedError");
  const describeError = useDescribeError();
  const tabCarriesLink = useOutOfCredits((s) => s.out);
  // The English constant is what every surface and the model compare; the
  // reader sees it in the page's language.
  if (failureText(error) === NO_CREDITS_MESSAGE) {
    if (!link && tabCarriesLink) return <>{t("insufficientCredits")}</>;
    return (
      <>
        {t.rich("insufficientCreditsReload", {
          link: (chunks) => (
            <button
              type="button"
              className="cursor-pointer font-medium underline hover:no-underline"
              onClick={openCreditsWall}
            >
              {chunks}
            </button>
          ),
        })}
      </>
    );
  }
  return <>{describeError(error, fallback ?? t("failed"))}</>;
}
