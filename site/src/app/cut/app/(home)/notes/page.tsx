import { Suspense } from "react";
import { NotesView } from "@/cut/components/NotesView";
import { SessionGate } from "@/cut/components/SessionGate";

export const instant = true;

export default function NotesPage() {
  return (
    <Suspense>
      <SessionGate>
        <NotesView />
      </SessionGate>
    </Suspense>
  );
}
