"use client";

import { useCallback } from "react";

import { useLocalPref } from "@/cut/lib/uiState";

// What was sent last, kept in this browser so the next note can start from it
// and be edited. It stays here on purpose: the server keeps status and
// timestamps for a conversation, never the words. The two send toggles ride
// along, so a start point recalls how it went out as well as what it said.
export type OutreachDraft = {
  subject: string;
  body: string;
  unsubscribeLink: boolean;
  trackReplies: boolean;
  savedAt: string;
};

// The toggles are optional on disk: entries written before they existed read
// as off, which is how those notes went out.
type StoredDraft = {
  subject: string;
  body: string;
  unsubscribeLink?: boolean;
  trackReplies?: boolean;
  savedAt: string;
};

const KEY = "donkey.outreach.drafts";
const START_KEY = "donkey.outreach.lastStart";
const LIMIT = 20;

function isDraft(value: unknown): value is StoredDraft {
  if (typeof value !== "object" || value === null) return false;
  const draft = value as Record<string, unknown>;
  return (
    typeof draft.subject === "string" &&
    typeof draft.body === "string" &&
    typeof draft.savedAt === "string" &&
    (draft.unsubscribeLink === undefined ||
      typeof draft.unsubscribeLink === "boolean") &&
    (draft.trackReplies === undefined || typeof draft.trackReplies === "boolean")
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
  remember: (draft: Omit<OutreachDraft, "savedAt">) => string;
  forget: (savedAt: string) => void;
} {
  const [stored, setStored] = useLocalPref<StoredDraft[]>(KEY, [], (value) =>
    Array.isArray(value) && value.every(isDraft),
  );

  const drafts: OutreachDraft[] = stored.map((draft) => ({
    ...draft,
    trackReplies: draft.trackReplies ?? false,
    unsubscribeLink: draft.unsubscribeLink ?? false,
  }));

  const remember = useCallback(
    ({ body, subject, trackReplies, unsubscribeLink }: Omit<OutreachDraft, "savedAt">) => {
      // Sending the same note twice moves the entry up rather than doubling it.
      const rest = stored.filter(
        (draft) =>
          draft.subject !== subject ||
          draft.body !== body ||
          (draft.unsubscribeLink ?? false) !== unsubscribeLink ||
          (draft.trackReplies ?? false) !== trackReplies,
      );
      const savedAt = new Date().toISOString();
      setStored(
        [{ body, savedAt, subject, trackReplies, unsubscribeLink }, ...rest].slice(
          0,
          LIMIT,
        ),
      );
      return savedAt;
    },
    [stored, setStored],
  );

  const forget = useCallback(
    (savedAt: string) => {
      setStored(stored.filter((draft) => draft.savedAt !== savedAt));
    },
    [stored, setStored],
  );

  return { drafts, forget, remember };
}
