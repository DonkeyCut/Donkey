import { Suspense } from "react";
import { CameraRollView } from "@/cut/components/CameraRollView";
import { SessionGate } from "@/cut/components/SessionGate";

export const unstable_instant = { prefetch: "static" };

export default function CameraRollPage() {
  return (
    <Suspense>
      <SessionGate>
        <CameraRollView />
      </SessionGate>
    </Suspense>
  );
}
