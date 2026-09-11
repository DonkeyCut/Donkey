"use client";

import { createContext, useContext, useEffect, useState, type ReactNode } from "react";

// A page inside a surface (an open post under Blog) names itself to the
// header, which draws the surface as a link and the page after it.
const CrumbContext = createContext<{ crumb: string | null; setCrumb: (crumb: string | null) => void }>({
  crumb: null,
  setCrumb: () => {},
});

export function SuCrumbProvider({ children }: { children: ReactNode }) {
  const [crumb, setCrumb] = useState<string | null>(null);
  return <CrumbContext.Provider value={{ crumb, setCrumb }}>{children}</CrumbContext.Provider>;
}

export function useSuCrumbValue() {
  return useContext(CrumbContext).crumb;
}

// Names the page while the caller is mounted.
export function useSuCrumb(label: string) {
  const { setCrumb } = useContext(CrumbContext);
  useEffect(() => {
    setCrumb(label);
    return () => setCrumb(null);
  }, [label, setCrumb]);
}
