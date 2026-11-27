import type { Metadata } from "next";
import { getTranslations } from "next-intl/server";
import { Suspense } from "react";

import { NoSessionReplay } from "@/app/_components/NoSessionReplay";

import { PhoneSend } from "./PhoneSend";

// The page a phone opens by scanning the code in an Upload dialog. It needs no
// sign-in: the code in the address is the key, and it opens only while the
// dialog on the computer is open. The address is a key, so the page stays out
// of search and session replay.
export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations("upload.meta");
  return { title: t("title"), robots: { index: false, follow: false } };
}

export default function UploadPage() {
  return (
    <>
      <NoSessionReplay />
      {/* The code comes from the address, which is known only per request. */}
      <Suspense>
        <div translate="no" className="contents">
          <PhoneSend />
        </div>
      </Suspense>
    </>
  );
}
