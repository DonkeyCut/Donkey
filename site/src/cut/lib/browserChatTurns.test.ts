import { expect, test } from "bun:test";
import { beginBrowserChat, browserChatRunning, cancelBrowserChat } from "./browserChatTurns";

test("a reopened panel sees and stops the existing browser turn", () => {
  const turn = beginBrowserChat("original", "chat");
  expect(browserChatRunning("original", "chat")).toBe(true);
  expect(browserChatRunning("other", "chat")).toBe(false);
  let rejected = false;
  try { beginBrowserChat("original", "chat"); } catch { rejected = true; }
  expect(rejected).toBe(true);
  cancelBrowserChat("original", "chat");
  expect(turn.signal.aborted).toBe(true);
  turn.finish();
  expect(browserChatRunning("original", "chat")).toBe(false);
});
