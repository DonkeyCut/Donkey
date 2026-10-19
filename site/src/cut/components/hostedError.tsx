import { NO_CREDITS_MESSAGE } from "@/cut/lib/credits";
import { creditsUrl } from "@/cut/lib/generate";
import { useOutOfCredits } from "@/cut/lib/hosted";
import { openUpgrade } from "@/cut/lib/upgrade";

/** Opens the upgrade dialog on its credits wall. A surface without the dialog
 * (the ChatGPT card) opens the credits page. */
export function openCreditsWall(): void {
  if (openUpgrade("credits")) {
    return;
  }
  window.open(creditsUrl(), "_blank", "noreferrer");
}

/** A hosted-inference error message (chat reply or generation tile). A balance
 * failure reads "Insufficient credits, reload here" with the link to the
 * credits wall inline; any other error (or a missing message) renders as plain text.
 * Surfaces inside the chat panel pass `link={false}` and lean on the composer's
 * credits tab for the link — but that tab only rises for an empty balance, so a
 * balance merely short of one generation keeps its link here. */
export function HostedErrorText({ error, link = true }: { error?: string; link?: boolean }) {
  const tabCarriesLink = useOutOfCredits((s) => s.out);
  if (error === NO_CREDITS_MESSAGE) {
    if (!link && tabCarriesLink) return <>{NO_CREDITS_MESSAGE}</>;
    return (
      <>
        {error},{" "}
        <button
          type="button"
          className="cursor-pointer font-medium underline hover:no-underline"
          onClick={openCreditsWall}
        >
          reload here
        </button>
      </>
    );
  }
  return <>{error ?? "Failed."}</>;
}
