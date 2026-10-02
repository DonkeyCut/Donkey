import { describe, expect, test } from "bun:test";
import { FoldInbox, foldIntoTurn, openFoldInbox } from "./turnFolds";

describe("FoldInbox", () => {
  test("a listening run takes each fold as it lands", async () => {
    const inbox = new FoldInbox();
    const taken: string[] = [];
    inbox.listen((fold) => {
      taken.push(fold.text);
      fold.resolve(true);
    });
    expect(await inbox.push("tighter")).toBe(true);
    expect(taken).toEqual(["tighter"]);
  });

  test("folds between runs wait for the next listener", async () => {
    const inbox = new FoldInbox();
    const stop = inbox.listen(() => {});
    stop();
    const answer = inbox.push("later");
    const taken: string[] = [];
    inbox.listen((fold) => {
      taken.push(fold.text);
      fold.resolve(true);
    });
    expect(taken).toEqual(["later"]);
    expect(await answer).toBe(true);
  });

  test("closing hands back what no run took and refuses new folds", async () => {
    const inbox = new FoldInbox();
    const waiting = inbox.push("orphan");
    inbox.close();
    expect(await waiting).toBe(false);
    expect(await inbox.push("after")).toBe(false);
  });

  test("take drains the folds waiting between runs", () => {
    const inbox = new FoldInbox();
    void inbox.push("a");
    void inbox.push("b");
    expect(inbox.take().map((f) => f.text)).toEqual(["a", "b"]);
    expect(inbox.take()).toEqual([]);
  });
});

describe("foldIntoTurn", () => {
  test("reaches only the thread's running turn", async () => {
    expect(await foldIntoTurn("p", "t", "nobody home")).toBe(false);
    const turn = openFoldInbox("p", "t");
    turn.inbox.listen((fold) => fold.resolve(true));
    expect(await foldIntoTurn("p", "t", "hi")).toBe(true);
    expect(await foldIntoTurn("p", "other", "hi")).toBe(false);
    turn.close();
    expect(await foldIntoTurn("p", "t", "late")).toBe(false);
  });
});
