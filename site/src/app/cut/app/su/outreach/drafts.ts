"use client";

import { useCallback } from "react";

import { useLocalPref } from "@/cut/lib/uiState";

// What was sent last, kept in this browser so the next note can start from it
// and be edited. It stays here on purpose: the server keeps status and
// timestamps for a conversation, never the words.
export type OutreachDraft = {
  subject: string;
  body: string;
  savedAt: string;
};

const KEY = "donkey.outreach.drafts";
const START_KEY = "donkey.outreach.lastStart";
const LIMIT = 20;

function isDraft(value: unknown): value is OutreachDraft {
  if (typeof value !== "object" || value === null) return false;
  const draft = value as Record<string, unknown>;
  return (
    typeof draft.subject === "string" &&
    typeof draft.body === "string" &&
    typeof draft.savedAt === "string"
  );
}

// Which start point the last note went out from, so the next row opens on it.
export function useLastOutreachStart(): [string | null, (id: string) => void] {
  return useLocalPref<string | null>(
    START_KEY,
    null,
    (value) => value === null || typeof value === "string",
  );
}

export function useOutreachDrafts(): {
  drafts: OutreachDraft[];
  remember: (draft: { subject: string; body: string }) => string;
  forget: (savedAt: string) => void;
} {
  const [drafts, setDrafts] = useLocalPref<OutreachDraft[]>(KEY, [], (value) =>
    Array.isArray(value) && value.every(isDraft),
  );

  const remember = useCallback(
    ({ body, subject }: { subject: string; body: string }) => {
      // Sending the same words twice moves the entry up rather than doubling it.
      const rest = drafts.filter(
        (draft) => draft.subject !== subject || draft.body !== body,
      );
      const savedAt = new Date().toISOString();
      setDrafts([{ body, savedAt, subject }, ...rest].slice(0, LIMIT));
      return savedAt;
    },
    [drafts, setDrafts],
  );

  const forget = useCallback(
    (savedAt: string) => {
      setDrafts(drafts.filter((draft) => draft.savedAt !== savedAt));
    },
    [drafts, setDrafts],
  );

  return { drafts, forget, remember };
}
