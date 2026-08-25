"use client";

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { useState, type ReactNode } from "react";

export function QueryProvider({ children }: { children: ReactNode }) {
  const [client] = useState(
    () =>
      new QueryClient({
        defaultOptions: {
          queries: {
            // Every query here is one account-scoped listing under a fixed
            // key — the sidebar's surfaces, the projects and library shelves,
            // the account row — so the whole set is small and bounded. Holding
            // it for the life of the tab is what makes a surface that unmounts
            // (the sidebar, while a project is open) paint its last answer the
            // moment it comes back, with the fresh read landing behind it.
            gcTime: Infinity,
            refetchOnWindowFocus: false,
            retry: 1,
            staleTime: 30_000,
          },
        },
      }),
  );

  return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
}
