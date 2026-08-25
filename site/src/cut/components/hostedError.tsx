import { NO_CREDITS_MESSAGE } from "@/cut/lib/credits";
import { creditsUrl } from "@/cut/lib/generate";
import { useOutOfCredits } from "@/cut/lib/hosted";

/** A hosted-inference error message (chat reply or generation tile). A balance
 * failure reads "Insufficient credits, reload here" with the credits link
 * inline; any other error (or a missing message) renders as plain text.
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
        <a
          className="font-medium underline hover:no-underline"
          href={creditsUrl()}
          target="_blank"
          rel="noreferrer"
        >
          reload here
        </a>
      </>
    );
  }
  return <>{error ?? "Failed."}</>;
}
