// The page's one query client, for code that runs outside React — the chat's
// tools — and needs the same cached account reads the page has. Absent in a
// headless process, which has no page.
import type { QueryClient } from "@tanstack/react-query";

let appClient: QueryClient | null = null;

export function bindAppQueryClient(client: QueryClient) {
  appClient = client;
}

export function appQueryClient(): QueryClient | null {
  return appClient;
}
