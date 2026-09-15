import type { Metadata } from "next";
import { Suspense } from "react";
import { NoSessionReplay } from "@/app/_components/NoSessionReplay";
import { SharedLibraryView } from "@/cut/components/SharedLibraryView";

export const metadata: Metadata = {
  title: "Shared library · Donkey Cut",
  robots: { index: false, follow: false },
};
export default function SharedLibraryPage() {
  return <><NoSessionReplay /><Suspense><SharedLibraryView /></Suspense></>;
}
