import type { UIMessage } from "ai";
import { INTERRUPTED_ERROR } from "./chatResume";
import type { VideoProject } from "./genvideo/types";

/** Reconcile the latest scene call with its persisted job after reconnecting. */
export function recoverSceneCall(
  messages: UIMessage[],
  threadId: string,
  scene: VideoProject | undefined,
): UIMessage[] {
  if (!scene || scene.chatId !== threadId) return messages;
  let recovered = false;
  return messages.toReversed().map((message) => {
    const parts = message.parts.toReversed().map((part) => {
      const tool = part as { type: string; toolName?: string; state?: string; errorText?: string; input?: { brief?: string; from_audio_asset_id?: string } };
      const name = tool.type === "dynamic-tool" ? tool.toolName : tool.type.slice(5);
      if (recovered || name !== "generate_scene") return part;
      recovered = true;
      if (typeof tool.input?.brief === "string" && tool.input.brief.trim() !== scene.brief) return part;
      if (typeof tool.input?.from_audio_asset_id === "string" && tool.input.from_audio_asset_id !== scene.audioAssetId) return part;
      if (tool.state === "output-available") return part;
      if (tool.state === "output-error" && tool.errorText !== INTERRUPTED_ERROR) return part;
      const { errorText: _error, ...rest } = part as typeof part & { errorText?: string };
      void _error;
      if (scene.phase === "failed")
        return { ...rest, state: "output-error", errorText: "The video run failed. See its progress card." } as typeof part;
      if (scene.phase === "storyboard" || scene.breakdownApproved || scene.phase === "done")
        return { ...rest, state: "output-available", output: { planned: true, shots: scene.shots.length } } as typeof part;
      return { ...rest, state: "input-available" } as typeof part;
    }).toReversed();
    return parts.every((part, i) => part === message.parts[i]) ? message : { ...message, parts };
  }).toReversed();
}
