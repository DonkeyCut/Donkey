import { expect, test } from "bun:test";
import type { UIMessage } from "ai";
import type { VideoProject } from "./genvideo/types";
import { recoverSceneCall } from "./chatRecovery";

const messages = (errorText = "Interrupted."): UIMessage[] => [{ id: "reply", role: "assistant", parts: [
  { type: "dynamic-tool", toolName: "generate_scene", toolCallId: "scene", state: "output-error", input: {}, errorText },
] }];
const scene = (phase: VideoProject["phase"]): VideoProject => ({ chatId: "chat", phase, shots: [], breakdownApproved: false } as unknown as VideoProject);

test("a resumed plan clears interruption and later settles successfully", () => {
  const resumed = recoverSceneCall(messages(), "chat", scene("keyframes"));
  expect((resumed[0].parts[0] as { state: string }).state).toBe("input-available");
  expect("errorText" in resumed[0].parts[0]).toBe(false);
  expect((recoverSceneCall(resumed, "chat", scene("storyboard"))[0].parts[0] as { state: string }).state).toBe("output-available");
});

test("another thread and genuine tool failures retain their errors", () => {
  const input = messages();
  expect(recoverSceneCall(input, "another", scene("done"))).toBe(input);
  expect((recoverSceneCall(messages("Out of credits."), "chat", scene("done"))[0].parts[0] as { errorText: string }).errorText).toBe("Out of credits.");
});

test("a failed scene remains failed", () => {
  expect((recoverSceneCall(messages(), "chat", scene("failed"))[0].parts[0] as { state: string }).state).toBe("output-error");
});

test("an older scene cannot settle a later call for a different brief", () => {
  const input = messages();
  const tool = input[0].parts[0] as { input: unknown };
  tool.input = { brief: "A different video" };
  const result = recoverSceneCall(input, "chat", { ...scene("done"), brief: "The earlier video" });
  expect((result[0].parts[0] as { errorText: string }).errorText).toBe("Interrupted.");
});
