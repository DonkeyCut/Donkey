import { expect, test } from "bun:test";
import { QueryClient, QueryObserver } from "@tanstack/react-query";
import { libraryKey, notesKey, projectsKey, refreshMentionSources } from "./queries";

test("a new mention re-reads every listing written outside this tab", async () => {
  const client = new QueryClient();
  const reads = new Map<string, number>();
  const keys = [notesKey, projectsKey("cloud"), projectsKey("local"), libraryKey("cloud+local")];
  const observers = keys.map((queryKey) => {
    const name = queryKey.join("/");
    const observer = new QueryObserver(client, {
      queryKey,
      queryFn: async () => {
        reads.set(name, (reads.get(name) ?? 0) + 1);
        return [];
      },
      staleTime: Infinity,
    });
    observer.subscribe(() => {});
    return observer;
  });
  await new Promise((r) => setTimeout(r, 10));

  refreshMentionSources(client);
  await new Promise((r) => setTimeout(r, 10));
  for (const key of keys) {
    expect(reads.get(key.join("/"))).toBe(2);
  }
  for (const observer of observers) {
    observer.destroy();
  }
});
