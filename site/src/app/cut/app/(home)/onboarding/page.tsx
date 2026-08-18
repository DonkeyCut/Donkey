"use client";

import { Suspense, useEffect, useRef } from "react";
import { useRouter } from "next/navigation";

import { ProjectsHome } from "@/cut/components/ProjectsHome";
import { SessionGate } from "@/cut/components/SessionGate";
import { cloudBackend } from "@/cut/lib/backend/cloud";
import { CUT_APP_BASE } from "@/cut/lib/nav";
import { starterProjectId } from "@/cut/lib/starter";
import { authClient } from "@/lib/auth-client";

// The welcome sequence's own address. The sequence is a full-window overlay
// mounted in the app shell that reads this address itself and opens from its
// first paint, so this route only renders what's underneath it. A signup lands
// here, and a new account arrives with its seeded starter project — so under
// the slides this route moves to that project's editor, and closing the last
// slide hands over to a cut ready to explore. An account without a starter
// (seed failed, or an older account revisiting this address) stays on the app
// home, the same thing that's behind the sequence everywhere else.
export default function OnboardingPage() {
  const router = useRouter();
  const { data: session } = authClient.useSession();
  const userId = session?.user.id;
  const sent = useRef(false);

  useEffect(() => {
    if (!userId || sent.current) return;
    let cancelled = false;
    void (async () => {
      const id = starterProjectId(userId);
      // Straight to the cloud surface: the starter is always a cloud project,
      // whichever backend the connect gate picks for this browser.
      const res = await cloudBackend.fetch(`/api/cut/projects/${id}`).catch(() => null);
      if (cancelled || !res?.ok || sent.current) return;
      sent.current = true;
      router.replace(`${CUT_APP_BASE}/p/${id}`);
    })();
    return () => {
      cancelled = true;
    };
  }, [userId, router]);

  return (
    <Suspense>
      <SessionGate>
        <ProjectsHome />
      </SessionGate>
    </Suspense>
  );
}
