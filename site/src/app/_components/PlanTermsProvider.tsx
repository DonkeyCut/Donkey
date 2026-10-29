"use client";

import { createContext, useContext, type ReactNode } from "react";

import type { PlanTermsTable } from "@/lib/billing/plans";

// The plan terms the root layout read on the server, handed to every card
// that sells a plan. They arrive in the page's HTML, so nothing waits on a
// fetch and no figure repaints after the first frame.
const PlanTermsContext = createContext<PlanTermsTable | null>(null);

export function PlanTermsProvider({ terms, children }: { terms: PlanTermsTable; children: ReactNode }) {
  return <PlanTermsContext.Provider value={terms}>{children}</PlanTermsContext.Provider>;
}

export function usePlanTerms(): PlanTermsTable {
  const terms = useContext(PlanTermsContext);
  if (!terms) {
    throw new Error("usePlanTerms needs a PlanTermsProvider above it.");
  }
  return terms;
}
