import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { confirmEngineUser, setEngineUser } from "./api";
import { bindCutMode, releaseCutMode } from "./backend";
import { flushNoteOutbox } from "./noteOutbox";
import { deleteNote, fetchNotes, saveNote, type CutNote } from "./notes";

// A note edit is saved in this browser before it is sent, so a server that
// is down or a tab that closes mid-edit never loses the words.

const storage = new Map<string, string>();
const originalFetch = globalThis.fetch;

// What the stub server holds, and whether it is answering.
let server = new Map<string, CutNote>();
let up = true;
let refuse = false;
const puts: string[] = [];

const pendingKeys = () => [...storage.keys()].filter((k) => k.startsWith("cut:note-outbox:"));
const write = (id: string, body = "Draft") => ({ id, title: "Script", body, colorIndex: 0, folderId: null, labelIds: [] });

beforeEach(() => {
  storage.clear();
  server = new Map();
  up = true;
  refuse = false;
  puts.length = 0;
  Object.assign(globalThis, {
    localStorage: {
      getItem: (key: string) => storage.get(key) ?? null,
      setItem: (key: string, value: string) => void storage.set(key, value),
      removeItem: (key: string) => void storage.delete(key),
      get length() {
        return storage.size;
      },
      key: (i: number) => [...storage.keys()][i] ?? null,
    },
  });
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    if (!up) {
      throw new TypeError("Failed to fetch");
    }
    const url = new URL(String(input), "https://example.test");
    const id = decodeURIComponent(url.pathname.split("/").pop() ?? "");
    if (init?.method === "PUT") {
      if (refuse) {
        return new Response("", { status: 400 });
      }
      const body = JSON.parse(String(init.body)) as CutNote;
      puts.push(body.body);
      const held = server.get(id);
      const kept = held && held.updatedAt > body.updatedAt ? held : { ...body, deletedAt: null, createdAt: 1 };
      server.set(id, kept);
      return Response.json(kept);
    }
    if (init?.method === "DELETE") {
      server.delete(id);
      return Response.json({ ok: true });
    }
    return Response.json({ notes: [...server.values()], folders: [], labels: [] });
  }) as typeof fetch;
  bindCutMode("cloud");
});
afterEach(() => {
  globalThis.fetch = originalFetch;
  releaseCutMode();
});

describe("a process with no account bound", () => {
  test("sends straight through and keeps nothing behind", async () => {
    const saved = await saveNote(write("n0", "From the worker"));
    expect(saved.body).toBe("From the worker");
    expect(pendingKeys()).toEqual([]);
  });
});

describe("a signed-in browser", () => {
  beforeEach(() => confirmEngineUser("owner"));

  test("an edit made while the server is down is kept and synced later", async () => {
    up = false;
    const saved = await saveNote(write("n1", "Offline words"));
    expect(saved.body).toBe("Offline words");

    // Reopened before the server is back: the list still shows the edit.
    up = true;
    server.set("n1", { ...write("n1", "Old words"), updatedAt: 1, deletedAt: null, createdAt: 1 });
    const listed = await fetchNotes();
    expect(listed.notes.find((n) => n.id === "n1")?.body).toBe("Offline words");

    await flushNoteOutbox();
    expect(server.get("n1")?.body).toBe("Offline words");
    expect(pendingKeys()).toEqual([]);
  });

  test("a newer edit from the phone wins over a pending one", async () => {
    up = false;
    await saveNote(write("n2", "Desk"));
    up = true;
    server.set("n2", { ...write("n2", "Phone"), updatedAt: Date.now() + 60_000, deletedAt: null, createdAt: 1 });
    const listed = await fetchNotes();
    expect(listed.notes.find((n) => n.id === "n2")?.body).toBe("Phone");
    expect(pendingKeys()).toEqual([]);
  });

  test("a write the server refuses leaves the outbox and says so", async () => {
    refuse = true;
    await expect(saveNote(write("n3"))).rejects.toThrow("Could not save the note.");
    expect(pendingKeys()).toEqual([]);
  });

  test("full storage still saves, and syncs from memory", async () => {
    up = false;
    const setItem = localStorage.setItem;
    localStorage.setItem = () => {
      throw new DOMException("full", "QuotaExceededError");
    };
    try {
      expect((await saveNote(write("n6", "Kept in memory"))).body).toBe("Kept in memory");
    } finally {
      localStorage.setItem = setItem;
    }
    up = true;
    await flushNoteOutbox();
    expect(server.get("n6")?.body).toBe("Kept in memory");
  });

  test("deleting a note drops its pending edit", async () => {
    up = false;
    await saveNote(write("n4"));
    up = true;
    await deleteNote("n4");
    await flushNoteOutbox();
    expect(server.has("n4")).toBe(false);
    expect(puts).toEqual([]);
  });

  test("an account the session has not confirmed sends nothing", async () => {
    up = false;
    await saveNote(write("n5", "Owner's words"));
    up = true;
    setEngineUser("visitor");
    await flushNoteOutbox();
    expect(puts).toEqual([]);
    expect((await fetchNotes()).notes.some((n) => n.id === "n5")).toBe(false);

    confirmEngineUser("owner");
    await flushNoteOutbox();
    expect(server.get("n5")?.body).toBe("Owner's words");
  });
});
