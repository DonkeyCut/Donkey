"use client";

import { useCallback } from "react";

import { useLocalPref } from "@/cut/lib/uiState";

// What was sent last, kept in this browser so the next note can start from it
// and be edited. It stays here on purpose: the server keeps status and
// timestamps for a conversation, never the words. The two send toggles ride
// along, so a start point recalls how it went out as well as what it said.
export type OutreachDraft = {
  id: string;
  subject: string;
  body: string;
  unsubscribeLink: boolean;
  trackReplies: boolean;
  savedAt: string;
};

// The toggles and the id are optional on disk. Entries written before the
// toggles existed read as on: every note back then carried the opt-out footer
// and the tracked reply alias. An entry without an id is identified by its
// timestamp.
type StoredDraft = {
  id?: string;
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
    (draft.id === undefined || typeof draft.id === "string") &&
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
  remember: (draft: Omit<OutreachDraft, "id" | "savedAt">) => string;
  forget: (id: string) => void;
} {
  const [stored, setStored] = useLocalPref<StoredDraft[]>(KEY, [], (value) =>
    Array.isArray(value) && value.every(isDraft),
  );

  const drafts: OutreachDraft[] = stored.map((draft) => ({
    ...draft,
    id: draft.id ?? draft.savedAt,
    trackReplies: draft.trackReplies ?? true,
    unsubscribeLink: draft.unsubscribeLink ?? true,
  }));

  const remember = useCallback(
    ({
      body,
      subject,
      trackReplies,
      unsubscribeLink,
    }: Omit<OutreachDraft, "id" | "savedAt">) => {
      const id = crypto.randomUUID();
      const savedAt = new Date().toISOString();
      setStored((current) => {
        // Sending the same note twice moves the entry up rather than doubling it.
        const rest = current.filter(
          (draft) =>
            draft.subject !== subject ||
            draft.body !== body ||
            (draft.unsubscribeLink ?? true) !== unsubscribeLink ||
            (draft.trackReplies ?? true) !== trackReplies,
        );
        return [
          { body, id, savedAt, subject, trackReplies, unsubscribeLink },
          ...rest,
        ].slice(0, LIMIT);
      });
      return id;
    },
    [setStored],
  );

  const forget = useCallback(
    (id: string) => {
      setStored((current) =>
        current.filter((draft) => (draft.id ?? draft.savedAt) !== id),
      );
    },
    [setStored],
  );

  return { drafts, forget, remember };
}
